/**
 * SSE（Server-Sent Events）增量解析器
 * ------------------------------------------------------------------
 * 为什么不用 EventSource？
 *   EventSource 只支持 GET，而大模型的对话接口需要 POST + JSON body，
 *   所以只能自己用 fetch + ReadableStream 手动解析流。
 *
 * 解析要点：
 *   1. 网络分片（chunk）不等于事件边界 —— 一个事件可能被切成几段，
 *      也可能一次到达好几个，所以必须自己维护缓冲区；
 *   2. 换行符可能是 \n 也可能是 \r\n，要先归一化；
 *   3. 流结束时缓冲区里可能还残留最后一个事件，必须冲刷。
 */

/** 从一段原始事件文本中取出 data 字段（SSE 允许多行 data，用 \n 连接） */
function extractData(rawEvent: string): string | null {
  const parts: string[] = []
  for (const line of rawEvent.split('\n')) {
    if (line.startsWith('data:')) {
      parts.push(line.slice(5).replace(/^ /, ''))
    }
  }
  return parts.length > 0 ? parts.join('\n') : null
}

/**
 * 把字节流转换成一条条 data 负载。
 * 调用方拿到的是纯字符串，需要自己 JSON.parse。
 */
export async function* parseSSEStream(stream: ReadableStream<Uint8Array>): AsyncGenerator<string, void, undefined> {
  const reader = stream.getReader()
  // stream: true 让解码器缓存跨分片的不完整多字节字符（中文必需）
  const decoder = new TextDecoder('utf-8')
  let buffer = ''

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      // 归一化换行，兼容 \r\n / \r
      if (buffer.includes('\r')) buffer = buffer.replace(/\r\n?/g, '\n')

      let boundary = buffer.indexOf('\n\n')
      while (boundary !== -1) {
        const rawEvent = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const data = extractData(rawEvent)
        if (data !== null) yield data
        boundary = buffer.indexOf('\n\n')
      }
    }

    // 冲刷残留：有些服务端最后一个事件后面没有空行。
    // 无参数调用 decode() 会把解码器里缓存的不完整多字节字节吐出来，
    // 否则最后那个汉字会被吞掉。
    buffer += decoder.decode()
    const tail = extractData(buffer)
    if (tail !== null) yield tail
  } finally {
    // 提前中断（用户点了停止）时也要释放锁，否则流会泄漏
    reader.releaseLock()
  }
}
