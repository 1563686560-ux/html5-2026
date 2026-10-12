import { describe, expect, it } from 'vitest'
import { chunkText } from './chunker'

describe('chunkText 中文分块', () => {
  it('空输入返回空数组', () => {
    expect(chunkText('')).toEqual([])
    expect(chunkText('   \n\n  ')).toEqual([])
  })

  it('短文本切成一个块', () => {
    const chunks = chunkText('第一段内容。\n\n第二段内容。')
    expect(chunks).toHaveLength(1)
    expect(chunks[0].content).toContain('第一段内容')
    expect(chunks[0].content).toContain('第二段内容')
  })

  it('超长单段切出多个块，且保留重叠', () => {
    const paragraph = Array.from({ length: 300 }, (_, i) => `第${i}句，`).join('')
    const chunks = chunkText(paragraph, 120, 20)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(chunk.content.trim().length).toBeGreaterThan(0)
      expect(chunk.start).toBeGreaterThanOrEqual(0)
      expect(chunk.end).toBeGreaterThan(chunk.start)
    }
    // 位置单调递增，且后一块起点不超过前一块终点前 20 字符（即存在重叠）
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].start).toBeGreaterThan(chunks[i - 1].start)
      expect(chunks[i].start).toBeGreaterThanOrEqual(chunks[i - 1].end - 20)
    }
    // 完整块之间保持恰好 20 字符重叠
    for (let i = 1; i < chunks.length - 1; i++) {
      expect(chunks[i].content.slice(0, 20)).toBe(chunks[i - 1].content.slice(-20))
    }
  })

  it('在句号处优先断开', () => {
    const paragraph = '甲。'.repeat(200)
    const chunks = chunkText(paragraph, 80, 20)
    for (const chunk of chunks.slice(0, -1)) {
      expect(chunk.content.endsWith('。')).toBe(true)
    }
  })
})
