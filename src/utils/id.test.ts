import { describe, expect, it } from 'vitest'
import { createId } from './id'

describe('createId 短 ID', () => {
  it('带前缀', () => {
    expect(createId('msg')).toMatch(/^msg_/)
  })

  it('无前缀时不以下划线开头', () => {
    expect(createId()).not.toMatch(/^_/)
  })

  it('批量生成无重复', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => createId('x')))
    expect(ids.size).toBe(1000)
  })
})
