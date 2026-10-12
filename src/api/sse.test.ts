import { describe, expect, it } from 'vitest'
import { parseSSEStream } from './sse'

function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    }
  })
}

async function collect(chunks: string[]): Promise<string[]> {
  const result: string[] = []
  for await (const data of parseSSEStream(streamFromChunks(chunks))) result.push(data)
  return result
}

describe('parseSSEStream SSE 流解析', () => {
  it('解析标准事件', async () => {
    expect(await collect(['data: hello\n\n'])).toEqual(['hello'])
  })

  it('一个分片含多个事件', async () => {
    expect(await collect(['data: a\n\ndata: b\n\n'])).toEqual(['a', 'b'])
  })

  it('事件被切成多个分片', async () => {
    expect(await collect(['data: hel', 'lo\n\n'])).toEqual(['hello'])
  })

  it('兼容 CRLF 换行', async () => {
    expect(await collect(['data: hi\r\n\r\n'])).toEqual(['hi'])
  })

  it('多行 data 合并为一个负载', async () => {
    expect(await collect(['data: line1\ndata: line2\n\n'])).toEqual(['line1\nline2'])
  })

  it('中文跨分片不被截断', async () => {
    expect(await collect(['data: 你好', '世界\n\n'])).toEqual(['你好世界'])
  })

  it('忽略 [DONE] 之外的无关字段', async () => {
    expect(await collect(['event: message\ndata: 有效\n\n'])).toEqual(['有效'])
  })

  it('流结束冲刷无空行结尾的残留事件', async () => {
    expect(await collect(['data: tail'])).toEqual(['tail'])
  })
})
