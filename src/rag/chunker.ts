/** 中文友好的文本分块：保留原文位置，方便引用定位 */

export interface TextChunk {
  index: number
  content: string
  start: number
  end: number
}

const DEFAULT_SIZE = 520
const DEFAULT_OVERLAP = 80

const STOP_PUNCTUATION = ['。', '！', '？', '；', '\n']

function normalizeText(source: string): string {
  return source
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim()
}

export function chunkText(source: string, size = DEFAULT_SIZE, overlap = DEFAULT_OVERLAP): TextChunk[] {
  const text = normalizeText(source)
  if (!text) return []

  const chunks: TextChunk[] = []
  const push = (content: string, start: number): void => {
    const value = content.trim()
    if (!value) return
    chunks.push({ index: chunks.length, content: value, start, end: start + value.length })
  }

  // 直接按字符游标切分：位置精确、逻辑简单，句末标点处优先断开
  let cursor = 0
  while (cursor < text.length) {
    let end = Math.min(cursor + size, text.length)

    if (end < text.length) {
      const window = text.slice(cursor, end)
      let lastStop = -1
      for (const mark of STOP_PUNCTUATION) {
        lastStop = Math.max(lastStop, window.lastIndexOf(mark))
      }
      if (lastStop > size * 0.5) end = cursor + lastStop + 1
    }

    push(text.slice(cursor, end), cursor)
    if (end >= text.length) break

    // 回退 overlap 个字符保持上下文连续；至少前进一格避免死循环
    cursor = Math.max(end - overlap, cursor + 1)
  }

  return chunks
}
