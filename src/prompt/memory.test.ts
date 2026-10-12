import { describe, expect, it } from 'vitest'
import { parseExtractedMemories } from './memory'

describe('parseExtractedMemories 记忆结果解析', () => {
  it('解析合法 JSON 数组', () => {
    const result = parseExtractedMemories('[{"content":"用户是大学生","topic":"身份"}]')
    expect(result).toHaveLength(1)
    expect(result[0].content).toBe('用户是大学生')
    expect(result[0].topic).toBe('身份')
  })

  it('剥离 markdown 代码围栏', () => {
    const result = parseExtractedMemories('```json\n[{"content":"喜欢历史","topic":"偏好"}]\n```')
    expect(result).toHaveLength(1)
    expect(result[0].content).toBe('喜欢历史')
  })

  it('容忍前后有多余文字', () => {
    const result = parseExtractedMemories('结果如下：[{"content":"在准备考试"}] 完毕')
    expect(result).toHaveLength(1)
    expect(result[0].content).toBe('在准备考试')
  })

  it('空数组正常返回空', () => {
    expect(parseExtractedMemories('[]')).toEqual([])
  })

  it('非法内容返回空数组而不抛错', () => {
    expect(parseExtractedMemories('不是 JSON')).toEqual([])
    expect(parseExtractedMemories('')).toEqual([])
  })

  it('过滤空 content 和过长内容', () => {
    const long = 'x'.repeat(200)
    const result = parseExtractedMemories(
      `[{"content":"","topic":"其他"},{"content":"${long}","topic":"其他"},{"content":"正常","topic":"身份"}]`
    )
    expect(result).toHaveLength(1)
    expect(result[0].content).toBe('正常')
  })

  it('最多保留 5 条', () => {
    const items = Array.from({ length: 8 }, (_, i) => `{"content":"事实${i}","topic":"其他"}`).join(',')
    expect(parseExtractedMemories(`[${items}]`)).toHaveLength(5)
  })
})
