/**
 * 大模型客户端层
 * ------------------------------------------------------------------
 * 统一封装 OpenAI 兼容协议，是整个应用的核心资产：
 * P1 对话、P3 知识库、P5 辩论都建立在这一层之上。
 *
 * 设计要点：
 *   - 对话与 Embedding 使用各自独立的 EndpointConfig，互不干扰；
 *   - 只负责「请求 + 解析 + 错误归一化 + 超时重试」，不碰任何 UI 与状态；
 *   - 所有失败都抛出 ApiError（用户主动取消除外），调用方只需展示 message。
 */

import type { ChatMessage, EndpointConfig } from './types'
import { parseSSEStream } from './sse'

/** 单次请求的默认超时时间 */
const DEFAULT_TIMEOUT_MS = 90_000
/** 默认重试次数（不含首次） */
const DEFAULT_RETRIES = 2

export class ApiError extends Error {
  status: number

  constructor(message: string, status = 0) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

/** 用户主动取消（点了停止按钮） */
function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

/** 超时也走 DOMException，但名字不同，便于和"用户取消"区分 */
function isTimeout(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'TimeoutError'
}

/**
 * 只有「重试有可能成功」的错误才重试。
 * 鉴权失败、模型名写错这类问题重试一百次也一样，只会浪费额度。
 */
function isRetryable(error: unknown): boolean {
  if (isTimeout(error)) return true
  if (error instanceof ApiError) {
    // status 0 表示网络层失败（断网、DNS、CORS）
    if (error.status === 0) return true
    if (error.status === 429) return true
    if (error.status >= 500) return true
    return false
  }
  return false
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let timer = 0
    const onAbort = () => {
      window.clearTimeout(timer)
      reject(new DOMException('已取消', 'AbortError'))
    }
    timer = window.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)

    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * 把「外部取消信号」和「超时」合并成一个信号。
 * 不用 AbortSignal.any() 是因为它在旧版 Safari 上不可用。
 *
 * 这里的超时是**空闲超时**而不是总时长：每收到一段新内容就 refresh() 重置计时。
 * 否则一个正常但啰嗦的回复（连续吐字超过 90 秒）会被中途掐断，
 * 用户看到的就是"说到一半突然停了"。
 */
function linkSignals(external: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController()
  let timer = 0

  const refresh = (): void => {
    window.clearTimeout(timer)
    timer = window.setTimeout(() => {
      controller.abort(new DOMException('请求超时', 'TimeoutError'))
    }, timeoutMs)
  }

  const forward = () => controller.abort(new DOMException('已取消', 'AbortError'))

  if (external) {
    if (external.aborted) forward()
    else external.addEventListener('abort', forward, { once: true })
  }
  if (!controller.signal.aborted) refresh()

  return {
    signal: controller.signal,
    refresh,
    dispose() {
      window.clearTimeout(timer)
      external?.removeEventListener('abort', forward)
    }
  }
}

/** 拼接地址时容错末尾斜杠，避免出现 //chat/completions */
function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.trim().replace(/\/+$/, '')}${path}`
}

/** 把各家五花八门的错误响应统一成一句人话 */
async function describeFailure(res: Response): Promise<string> {
  if (res.status === 401 || res.status === 403) {
    return `鉴权失败（HTTP ${res.status}）：API Key 不正确，或该账号没有此模型的权限`
  }
  if (res.status === 404) {
    return `接口不存在（HTTP 404）：请检查 Base URL 与模型名是否正确`
  }
  if (res.status === 429) {
    return '请求过于频繁或额度已用尽（HTTP 429）'
  }

  let detail = ''
  try {
    const text = await res.text()
    if (text) {
      try {
        const json = JSON.parse(text) as {
          error?: { message?: string }
          message?: string
        }
        detail = json.error?.message ?? json.message ?? text.slice(0, 200)
      } catch {
        detail = text.slice(0, 200)
      }
    }
  } catch {
    /* 读不出响应体就用状态码兜底 */
  }
  return detail ? `请求失败（HTTP ${res.status}）：${detail}` : `请求失败（HTTP ${res.status}）`
}

/** 各家把错误信息塞在 error.message / error / message 里，统一取一句话 */
function pickErrorMessage(error: unknown): string | null {
  if (typeof error === 'string') return error
  if (error && typeof error === 'object') {
    const record = error as { message?: unknown; error?: unknown }
    if (typeof record.message === 'string') return record.message
  }
  return null
}

/**
 * 读取响应体。
 * 连接中途断开时 fetch 会抛原始英文 TypeError（"network error" / "Load failed"），
 * 直接冒到界面上用户看不懂，所以统一转成 ApiError(status 0)。
 * status 0 在 isRetryable 里代表"网络层失败"，可以安全重试。
 */
async function readJson<T>(res: Response, what: string): Promise<T> {
  try {
    return (await res.json()) as T
  } catch (error) {
    if (isAbort(error) || isTimeout(error)) throw error
    throw new ApiError(`${what}失败：${(error as Error).message || '连接中断'}`, 0)
  }
}

function assertEndpoint(endpoint: EndpointConfig, kind: string): void {
  if (!endpoint.baseUrl.trim()) throw new ApiError(`还没有配置${kind}的 Base URL`)
  if (!endpoint.apiKey.trim()) throw new ApiError(`还没有配置${kind}的 API Key`)
  if (!endpoint.model.trim()) throw new ApiError(`还没有配置${kind}的模型名`)
}

export interface StreamChatOptions {
  /** 外部取消信号（用户点「停止」） */
  signal?: AbortSignal
  /** 每次收到增量时回调；full 是到目前为止的完整文本 */
  onDelta?: (chunk: string, full: string) => void
  /**
   * 流正常结束后的回调。
   * truncated=true 表示服务端没有发 [DONE] 就断开了，回复可能不完整 ——
   * 调用方应据此决定是否还把这个回复当成"完整答案"使用（例如抽取记忆）。
   */
  onFinish?: (info: { truncated: boolean }) => void
  temperature?: number
  /** OpenAI 兼容的思考模式开关；未设置时沿用模型默认行为。 */
  thinking?: { type: 'enabled' | 'disabled' }
  timeoutMs?: number
  retries?: number
}

/** 单次尝试的结果：正文 + 是否缺少结束标记 */
interface StreamOutcome {
  text: string
  truncated: boolean
}

/** 单次尝试：负责发请求并消费 SSE 流 */
async function streamChatOnce(
  endpoint: EndpointConfig,
  messages: ChatMessage[],
  options: StreamChatOptions,
  signal: AbortSignal,
  /**
   * 每收到一个事件时回调。
   * hasContent=false 表示收到了事件但没有可见内容（心跳、推理过程等）：
   * 这算不上"已经吐字给用户"，但足以证明连接还活着、不该判超时。
   */
  onEvent: (hasContent: boolean) => void
): Promise<StreamOutcome> {
  let res: Response
  try {
    res = await fetch(joinUrl(endpoint.baseUrl, '/chat/completions'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${endpoint.apiKey.trim()}`
      },
      body: JSON.stringify({
        model: endpoint.model.trim(),
        messages,
        stream: true,
        temperature: options.temperature ?? 0.8,
        ...(options.thinking ? { thinking: options.thinking } : {})
      }),
      signal
    })
  } catch (error) {
    if (isAbort(error) || isTimeout(error)) throw error
    throw new ApiError(`网络请求失败：${(error as Error).message}`, 0)
  }

  if (!res.ok) throw new ApiError(await describeFailure(res), res.status)
  if (!res.body) throw new ApiError('当前浏览器不支持流式响应（response.body 为空）')

  /**
   * 有些兼容服务端会忽略 stream: true，直接返回一个普通的 JSON 补全；
   * 还有的会在 HTTP 200 里塞一个 {"error": ...}。两种都不是 SSE，
   * 必须单独处理 —— 否则前者会被当成"空回复"，后者会被当成"成功但没内容"。
   * 只在服务端明确声明 application/json 时才走这条分支，
   * 不声明 Content-Type 的接口仍按 SSE 解析，兼容性不受影响。
   */
  const contentType = res.headers.get('content-type')?.toLowerCase() ?? ''
  if (contentType.includes('application/json') && !contentType.includes('text/event-stream')) {
    const json = await readJson<{
      error?: unknown
      choices?: Array<{ message?: { content?: string | null } }>
    }>(res, '读取响应')

    const problem = pickErrorMessage(json.error)
    // 状态码是 200，用 200 作 ApiError.status 表示"不是网络问题、重试也没用"
    if (json.error && problem) throw new ApiError(`模型返回错误：${problem}`, 200)
    if (json.error) throw new ApiError('模型返回了错误，但没有说明原因', 200)

    const content = json.choices?.[0]?.message?.content
    if (typeof content === 'string' && content) {
      onEvent(true)
      options.onDelta?.(content, content)
      return { text: content, truncated: false }
    }
    throw new ApiError('模型没有返回内容，请检查模型名与接口地址是否正确', 200)
  }

  let full = ''
  let sawDone = false

  try {
    for await (const data of parseSSEStream(res.body)) {
      if (data === '[DONE]') {
        sawDone = true
        break
      }

      let parsed: unknown
      try {
        parsed = JSON.parse(data)
      } catch {
        // 有些服务会插入注释或心跳行，跳过即可
        continue
      }

      // 流式响应里也可能夹带错误对象
      const streamError = pickErrorMessage((parsed as { error?: unknown }).error)
      if (streamError) throw new ApiError(`模型返回错误：${streamError}`, 200)

      const choice = (parsed as { choices?: Array<{ delta?: { content?: string | null } }> }).choices?.[0]
      const chunk = choice?.delta?.content

      // 事件本身就算生命迹象。推理类模型在思考阶段只发 reasoning_content，
      // 一个可见字都没有，但连接是好的 —— 不能因此判超时。
      onEvent(Boolean(chunk))

      if (chunk) {
        full += chunk
        options.onDelta?.(chunk, full)
      }
    }
  } catch (error) {
    if (isAbort(error) || isTimeout(error) || error instanceof ApiError) throw error
    // 流中途断开：Chrome 抛 TypeError('network error')，Safari 抛 'Load failed'。
    // 归一化成 ApiError(status 0) 之后，只要还没吐过字就还能自动重试。
    throw new ApiError(`连接中断：${(error as Error).message || '数据流异常结束'}`, 0)
  }

  if (!full) {
    // 一个字都没有，多半是模型名写错或接口地址不对，重试没有意义
    throw new ApiError('模型没有返回任何内容，请检查模型名与接口地址是否正确', 200)
  }

  return { text: full, truncated: !sawDone }
}

/**
 * 流式对话补全（带空闲超时与自动重试）。
 *
 * 一个关键判断：**一旦已经开始吐字，就绝不重试**。
 * 因为重试会从空字符串重新生成，界面上已经显示的内容会突然"倒带"重来，
 * 用户看到的就是文字闪回 —— 宁可保留已生成的部分。
 */
export async function streamChat(
  endpoint: EndpointConfig,
  messages: ChatMessage[],
  options: StreamChatOptions = {}
): Promise<string> {
  assertEndpoint(endpoint, '对话模型')

  const retries = options.retries ?? DEFAULT_RETRIES
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  let attempt = 0
  for (;;) {
    const linked = linkSignals(options.signal, timeoutMs)
    let emitted = false

    // 收到任何事件都把空闲计时器往后推；只有真的吐了字才锁定"不再重试"
    const onEvent = (hasContent: boolean): void => {
      linked.refresh()
      if (hasContent) emitted = true
    }

    try {
      const outcome = await streamChatOnce(endpoint, messages, options, linked.signal, onEvent)
      options.onFinish?.({ truncated: outcome.truncated })
      return outcome.text
    } catch (error) {
      const cancelled = options.signal?.aborted === true
      const retryable = !emitted && !cancelled && isRetryable(error) && attempt < retries

      if (!retryable) {
        if (isTimeout(error)) {
          const waited = Math.round(timeoutMs / 1000)
          const tried = attempt > 0 ? `，已重试 ${attempt} 次` : ''
          throw new ApiError(`请求超时：${waited} 秒内没有收到新内容${tried}`)
        }
        throw error
      }

      attempt += 1
      // 指数退避：0.8s、1.6s……
      await delay(800 * attempt, options.signal)
    } finally {
      linked.dispose()
    }
  }
}

export interface CompleteChatOptions {
  signal?: AbortSignal
  temperature?: number
  timeoutMs?: number
  maxTokens?: number
}

/**
 * 非流式补全：用于记忆抽取、分类等结构化任务。
 * 对话主链路仍使用 streamChat，避免影响手机端首字反馈。
 */
export async function completeChat(
  endpoint: EndpointConfig,
  messages: ChatMessage[],
  options: CompleteChatOptions = {}
): Promise<string> {
  assertEndpoint(endpoint, '对话模型')
  const linked = linkSignals(options.signal, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)

  try {
    let res: Response
    try {
      res = await fetch(joinUrl(endpoint.baseUrl, '/chat/completions'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${endpoint.apiKey.trim()}`
        },
        body: JSON.stringify({
          model: endpoint.model.trim(),
          messages,
          stream: false,
          temperature: options.temperature ?? 0.25,
          ...(options.maxTokens ? { max_tokens: options.maxTokens } : {})
        }),
        signal: linked.signal
      })
    } catch (error) {
      if (isAbort(error) || isTimeout(error)) throw error
      throw new ApiError(`网络请求失败：${(error as Error).message}`, 0)
    }

    if (!res.ok) throw new ApiError(await describeFailure(res), res.status)

    const json = await readJson<{
      error?: unknown
      choices?: Array<{ message?: { content?: string | null } }>
    }>(res, '读取响应')

    // HTTP 200 也可能包着错误对象，不能只看状态码
    const problem = pickErrorMessage(json.error)
    if (json.error && problem) throw new ApiError(`模型返回错误：${problem}`)

    const content = json.choices?.[0]?.message?.content
    if (typeof content !== 'string') throw new ApiError('模型没有返回内容')
    return content
  } finally {
    linked.dispose()
  }
}

/** 文本向量化，供 P3 知识库检索使用 */
export async function embedTexts(
  endpoint: EndpointConfig,
  input: string[],
  options: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<number[][]> {
  assertEndpoint(endpoint, 'Embedding 模型')
  if (input.length === 0) return []

  const linked = linkSignals(options.signal, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)

  try {
    let res: Response
    try {
      res = await fetch(joinUrl(endpoint.baseUrl, '/embeddings'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${endpoint.apiKey.trim()}`
        },
        body: JSON.stringify({ model: endpoint.model.trim(), input }),
        signal: linked.signal
      })
    } catch (error) {
      if (isAbort(error) || isTimeout(error)) throw error
      throw new ApiError(`网络请求失败：${(error as Error).message}`, 0)
    }

    if (!res.ok) throw new ApiError(await describeFailure(res), res.status)

    const json = await readJson<{ error?: unknown; data?: Array<{ embedding?: number[]; index?: number }> }>(
      res,
      '读取响应'
    )

    const problem = pickErrorMessage(json.error)
    if (json.error && problem) throw new ApiError(`Embedding 接口返回错误：${problem}`)
    if (!json.data?.length) throw new ApiError('Embedding 接口返回了空结果')

    // 按 index 排序，保证返回顺序与输入顺序一致
    return [...json.data]
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      .map((item, i) => {
        if (!item.embedding?.length) throw new ApiError(`第 ${i + 1} 条文本没有返回向量`)
        return item.embedding
      })
  } finally {
    linked.dispose()
  }
}

export interface TestResult {
  ok: boolean
  message: string
}

/** 设置页的「测试连接」：分别验证对话与 Embedding 是否真的可用 */
export async function testChatEndpoint(endpoint: EndpointConfig): Promise<TestResult> {
  try {
    const reply = await streamChat(endpoint, [{ role: 'user', content: '回复两个字：可用' }], {
      temperature: 0,
      retries: 0,
      timeoutMs: 30_000
    })
    const preview = reply.trim().slice(0, 20) || '(空回复)'
    return { ok: true, message: `连接成功，模型回复：${preview}` }
  } catch (error) {
    return { ok: false, message: (error as Error).message }
  }
}

export async function testEmbedEndpoint(endpoint: EndpointConfig): Promise<TestResult> {
  try {
    const vectors = await embedTexts(endpoint, ['连通性测试'], { timeoutMs: 30_000 })
    const dim = vectors[0]?.length ?? 0
    return { ok: true, message: `连接成功，向量维度 ${dim}` }
  } catch (error) {
    return { ok: false, message: (error as Error).message }
  }
}
