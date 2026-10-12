import { describe, expect, it } from 'vitest'
import { buildReferences } from './references'
import type { SearchHit } from './types'

function hit(index: number, content: string, documentId = 'a'): SearchHit {
  return {
    score: 1,
    mode: 'keyword',
    chunk: {
      id: `${documentId}-${index}`,
      documentId,
      documentTitle: documentId,
      index,
      content,
      start: 0,
      end: content.length,
      createdAt: 0
    }
  }
}

describe('资料上下文', () => {
  it('排序并合并相邻块，重叠原文只出现一次', () => {
    expect(buildReferences([hit(1, '共同内容。后文。'), hit(0, '前文。共同内容。')])).toEqual([
      { title: 'a', content: '前文。共同内容。后文。', documentId: 'a', chunkIds: ['a-0', 'a-1'] }
    ])
  })
  it('不把不连续的段落或不同文档拼成一句话', () => {
    expect(buildReferences([hit(0, '甲'), hit(2, '乙'), hit(0, '丙', 'b')])).toHaveLength(3)
  })
})
