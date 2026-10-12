import { describe, expect, it } from 'vitest'
import { computed, reactive, ref } from 'vue'
import { toPlain } from './plain'

describe('toPlain：写入 IndexedDB 前去掉响应式代理', () => {
  it('结构化克隆 Proxy 会失败，而 toPlain 之后可以克隆', () => {
    const record = ref({ enabled: true, salt: 'abc', hash: 'def' })

    expect(() => structuredClone(record.value)).toThrow()
    expect(structuredClone(toPlain(record.value))).toEqual({ enabled: true, salt: 'abc', hash: 'def' })
  })

  it('reactive 对象也能还原', () => {
    const state = reactive({ a: 1, nested: { b: 2 } })
    expect(() => structuredClone(state)).toThrow()
    expect(structuredClone(toPlain(state))).toEqual({ a: 1, nested: { b: 2 } })
  })

  it('多层嵌套与数组里的代理都会被拆掉', () => {
    const list = ref([{ id: '1', tags: ['a'] }, { id: '2', tags: ['b'] }])
    const plain = toPlain({ list: list.value, nested: { deep: reactive({ x: 1 }) } })

    // 任何一层残留代理都会让结构化克隆抛 DataCloneError
    expect(() => structuredClone(plain)).not.toThrow()
    expect(structuredClone(plain)).toEqual({
      list: [{ id: '1', tags: ['a'] }, { id: '2', tags: ['b'] }],
      nested: { deep: { x: 1 } }
    })
  })

  it('直接传 ref 或 computed 也会被拆开', () => {
    const count = ref(3)
    expect(toPlain(count)).toBe(3)
    expect(toPlain(computed(() => 'hi'))).toBe('hi')
  })

  it('保留 Date、TypedArray 等非普通对象原样可克隆', () => {
    const when = new Date('2024-01-02T03:04:05.000Z')
    const vector = new Float32Array([0.5, 0.25])
    const plain = toPlain(reactive({ when, vector })) as { when: Date; vector: Float32Array }

    expect(plain.when).toBeInstanceOf(Date)
    expect(plain.vector).toBeInstanceOf(Float32Array)
    expect(() => structuredClone(plain)).not.toThrow()
  })

  it('Map / Set 会被还原成普通容器', () => {
    const plain = toPlain(reactive({ m: new Map([['a', { v: 1 }]]), s: new Set([1, 2]) })) as {
      m: Map<string, unknown>
      s: Set<number>
    }
    expect(plain.m.get('a')).toEqual({ v: 1 })
    expect([...plain.s]).toEqual([1, 2])
    expect(() => structuredClone(plain)).not.toThrow()
  })

  it('原始值原样返回', () => {
    expect(toPlain(null)).toBeNull()
    expect(toPlain(undefined)).toBeUndefined()
    expect(toPlain(42)).toBe(42)
    expect(toPlain('文本')).toBe('文本')
  })

  it('__proto__ 这种键不会污染原型', () => {
    const source = reactive(JSON.parse('{"__proto__": {"polluted": true}, "safe": 1}') as Record<string, unknown>)
    const plain = toPlain(source) as Record<string, unknown>
    expect(Object.getPrototypeOf(plain)).toBe(Object.prototype)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(plain.safe).toBe(1)
  })
})
