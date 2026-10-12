/**
 * 客户端层行为测试
 * ------------------------------------------------------------------
 * 这里用假的 fetch 复现几种真实会遇到的坏情况：
 *   - 流中途断网（Chrome 抛 TypeError('network error')）
 *   - HTTP 200 里包着 {"error": ...}
 *   - 服务端忽略 stream:true，直接返回普通 JSON
 *   - 流结束但没发 [DONE]（回答是半截的）
 *   - 空回复
 * 这些都是"看起来成功、实际坏了"的情况，最难在真机上排查，必须在测试里钉住。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, streamChat } from './llm'
import type { EndpointConfig } from './types'

const endpoint: EndpointConfig = { baseUrl: 'https://example.com/v1', apiKey: 'sk-test', model: 'test-model' }
const messages = [{ role: 'user' as const, content: '你好' }]
const encoder = new TextEncoder()

beforeEach(() => {
  // llm.ts 用 window.setTimeout 来计时（DOM 的返回 number，比 NodeJS.Timeout 好处理），
  // 而 vitest 默认跑在 node 环境里，没有 window。这里补一个即可。
  vi.stubGlobal('window', globalThis)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/* ---- 构造测试用的流与响应 ---- */

function delta(text: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`
}

const DONE = 'data: [DONE]\n\n'

/** 立刻把给定片段推完并关闭 */
function staticBody(parts: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part))
      controller.close()
    }
  })
}

/** 一开始就报错，模拟连接建立后立刻断开 */
function droppedBody(error: unknown): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(error)
    }
  })
}

/** 只挂着不吐数据，直到信号被中止 */
function hangingBody(signal: AbortSignal): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      signal.addEventListener('abort', () => controller.error(signal.reason))
    }
  })
}

/**
 * 先正常吐出一段，之后再断开。
 * 注意必须用 pull 分两次交付：如果在 start 里先 enqueue 再 error，
 * 流实现会按规范清空队列，那段内容根本到不了消费者 ——
 * 测试也就测不到「已经吐字后断流」这条路径了。
 */
function dropAfterBody(parts: string[], error: unknown): ReadableStream<Uint8Array> {
  let sent = false
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) {
        sent = true
        for (const part of parts) controller.enqueue(encoder.encode(part))
        return
      }
      controller.error(error)
    }
  })
}

/** 每隔 gapMs 推一个原始片段，最后补 [DONE] 并关闭 */
function pacedBody(parts: string[], gapMs: number, signal: AbortSignal): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      signal.addEventListener('abort', () => controller.error(signal.reason))
      for (const part of parts) {
        await new Promise((resolve) => setTimeout(resolve, gapMs))
        controller.enqueue(encoder.encode(part))
      }
      controller.enqueue(encoder.encode(DONE))
      controller.close()
    }
  })
}

type BodyFactory = (signal: AbortSignal) => ReadableStream<Uint8Array>

function mockSse(factory: BodyFactory): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async (_url: string, init?: RequestInit) => {
    return new Response(factory(init?.signal as AbortSignal), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' }
    })
  })
  vi.stubGlobal('fetch', mock)
  return mock
}

function mockJson(body: unknown, status = 200): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async () => {
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' }
    })
  })
  vi.stubGlobal('fetch', mock)
  return mock
}

/* ---- 测试 ---- */

describe('streamChat：正常路径', () => {
  it('按需把思考模式开关写入请求体', async () => {
    const mock = mockSse(() => staticBody([delta('答案'), DONE]))

    await streamChat(endpoint, messages, { thinking: { type: 'disabled' } })

    const init = mock.mock.calls[0]?.[1] as RequestInit
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: 'test-model',
      thinking: { type: 'disabled' }
    })
  })

  it('拼接增量并在 [DONE] 后结束，标记为完整', async () => {
    mockSse(() => staticBody([delta('你'), delta('好'), DONE]))

    const seen: string[] = []
    const finishes: Array<{ truncated: boolean }> = []
    const reply = await streamChat(endpoint, messages, {
      onDelta: (_chunk, full) => seen.push(full),
      onFinish: (info) => finishes.push(info)
    })

    expect(reply).toBe('你好')
    expect(seen).toEqual(['你', '你好'])
    expect(finishes).toEqual([{ truncated: false }])
  })

  it('缺少 [DONE] 时保留内容，但标记为可能不完整', async () => {
    // 半截回答不能当成完整答案（否则会被拿去抽取记忆，污染记忆层）
    mockSse(() => staticBody([delta('说到一半')]))

    const finishes: Array<{ truncated: boolean }> = []
    const reply = await streamChat(endpoint, messages, { onFinish: (info) => finishes.push(info) })

    expect(reply).toBe('说到一半')
    expect(finishes).toEqual([{ truncated: true }])
  })
})

describe('streamChat：服务端返回 200 但其实是错误', () => {
  it('application/json + error 对象会抛出错误详情，而不是当成空回复', async () => {
    const mock = mockJson({ error: { message: 'Model not found: gpt-nope' } })

    // 这类问题重试一百次也一样，所以只请求一次
    await expect(streamChat(endpoint, messages)).rejects.toThrow(/Model not found: gpt-nope/)
    expect(mock).toHaveBeenCalledTimes(1)
  })

  it('忽略 stream:true 直接返回普通 JSON 时也能拿到内容', async () => {
    const mock = mockJson({ choices: [{ message: { content: '我是非流式回复' } }] })

    const reply = await streamChat(endpoint, messages, { retries: 0 })
    expect(reply).toBe('我是非流式回复')
    // 服务端没按流式返回，不应该重试
    expect(mock).toHaveBeenCalledTimes(1)
  })

  it('空回复抛出可读错误，而不是静默返回空串', async () => {
    const mock = mockSse(() => staticBody([DONE]))

    await expect(streamChat(endpoint, messages, { retries: 2 })).rejects.toThrow(/没有返回任何内容/)
    // 模型名/地址类问题重试没有意义，只请求一次
    expect(mock).toHaveBeenCalledTimes(1)
  })

  it('流里夹带的 error 对象也会被识别', async () => {
    mockSse(() => staticBody([`data: ${JSON.stringify({ error: { message: 'rate limited' } })}\n\n`]))

    await expect(streamChat(endpoint, messages, { retries: 0 })).rejects.toThrow(/rate limited/)
  })
})

describe('streamChat：断网与重试', () => {
  it('还没吐字就断流：归一化成中文错误，并且会重试', async () => {
    const mock = mockSse(() => droppedBody(new TypeError('network error')))

    const error = await streamChat(endpoint, messages, { retries: 1 }).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ApiError)
    expect((error as Error).message).toContain('连接中断')
    // 一个 token 都没吐出来，重试是安全的：首次 + 1 次重试
    expect(mock).toHaveBeenCalledTimes(2)
  })

  it('完全不重试时只请求一次，错误仍是 ApiError 而不是原始 TypeError', async () => {
    const mock = mockSse(() => droppedBody(new TypeError('network error')))

    const error = await streamChat(endpoint, messages, { retries: 0 }).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ApiError)
    expect((error as Error).message).toContain('连接中断')
    expect((error as Error).name).not.toBe('TypeError')
    expect(mock).toHaveBeenCalledTimes(1)
  })

  it('已经吐字后断流：不再重试（避免界面文字闪回）', async () => {
    let attempt = 0
    const mock = mockSse(() => {
      attempt += 1
      return attempt === 1
        ? dropAfterBody([delta('已经开始了')], new TypeError('network error'))
        : staticBody([delta('重来一遍'), DONE])
    })

    const seen: string[] = []
    const error = await streamChat(endpoint, messages, {
      retries: 2,
      onDelta: (_chunk, full) => seen.push(full)
    }).catch((e: unknown) => e)

    // 已经显示出来的内容必须保留，宁可报错也不能"倒带重来"
    expect(seen).toEqual(['已经开始了'])
    expect(error).toBeInstanceOf(ApiError)
    expect((error as Error).message).toContain('连接中断')
    expect(mock).toHaveBeenCalledTimes(1)
  })
})

describe('streamChat：超时是「空闲超时」而不是总时长', () => {
  it('持续吐字超过超时时间也不会被掐断', async () => {
    // 5 段 × 60ms = 300ms，远超 150ms 的超时；但每次间隔只有 60ms
    mockSse((signal) => pacedBody([delta('一'), delta('二'), delta('三'), delta('四'), delta('五')], 60, signal))

    const reply = await streamChat(endpoint, messages, { retries: 0, timeoutMs: 150 })
    expect(reply).toBe('一二三四五')
  })

  it('只有推理内容、还没有可见内容时也不算超时', async () => {
    // 推理类模型在思考阶段只发 reasoning_content，连接是好的，
    // 如果只把"可见内容"当作生命迹象，思考超过 90 秒就会被误判超时
    const thinking = (text: string): string =>
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: text } }] })}\n\n`

    mockSse((signal) => pacedBody([thinking('想'), thinking('啊'), delta('答案')], 80, signal))

    const reply = await streamChat(endpoint, messages, { retries: 0, timeoutMs: 150 })
    expect(reply).toBe('答案')
  })

  it('长时间收不到新内容才超时，提示写的是「没有收到新内容」', async () => {
    mockSse((signal) => hangingBody(signal))

    const error = await streamChat(endpoint, messages, { retries: 0, timeoutMs: 120 }).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ApiError)
    expect((error as Error).message).toMatch(/没有收到新内容/)
  })
})

describe('streamChat：参数校验', () => {
  it('缺少 Key 时直接报错，不发请求', async () => {
    const mock = mockSse(() => staticBody([DONE]))
    await expect(streamChat({ ...endpoint, apiKey: '  ' }, messages)).rejects.toThrow(/API Key/)
    expect(mock).not.toHaveBeenCalled()
  })
})
