import type { Reference } from '@/prompt/assembler'
import type { SearchHit } from './types'

/** 同一文档中相邻的命中按原文顺序合并，重叠部分只送一次。 */
export function buildReferences(hits: SearchHit[]): Reference[] {
  const groups = new Map<string, SearchHit[]>()
  for (const hit of hits) {
    const group = groups.get(hit.chunk.documentId) ?? []
    if (!group.some((item) => item.chunk.id === hit.chunk.id)) group.push(hit)
    groups.set(hit.chunk.documentId, group)
  }
  const references: Reference[] = []
  for (const group of groups.values()) {
    group.sort((a, b) => a.chunk.index - b.chunk.index)
    let previous: SearchHit['chunk'] | undefined
    let reference: Reference | undefined
    for (const { chunk } of group) {
      if (previous && reference && chunk.index === previous.index + 1) {
        // 旧存档的偏移可能未计入 trim；以实际文本确认重叠，避免误删正文。
        let overlap = Math.min(previous.content.length, chunk.content.length)
        while (overlap > 0 && !previous.content.endsWith(chunk.content.slice(0, overlap))) overlap--
        reference.content += overlap ? chunk.content.slice(overlap) : `\n${chunk.content}`
        reference.chunkIds?.push(chunk.id)
      } else {
        reference = {
          title: chunk.documentTitle,
          content: chunk.content,
          documentId: chunk.documentId,
          chunkIds: [chunk.id]
        }
        references.push(reference)
      }
      previous = chunk
    }
  }
  return references
}
