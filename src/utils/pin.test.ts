import { describe, expect, it, vi, afterEach } from 'vitest'
import { createHash, webcrypto } from 'node:crypto'
import { createSalt, hashPin } from './pin'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('PIN 哈希', () => {
  it('相同 PIN 与盐得到相同摘要', async () => {
    const salt = createSalt()
    expect(await hashPin('1234', salt)).toBe(await hashPin('1234', salt))
  })

  it('不同 PIN 得到不同摘要', async () => {
    const salt = createSalt()
    expect(await hashPin('1234', salt)).not.toBe(await hashPin('1235', salt))
  })

  it('盐随机且长度足够', () => {
    const a = createSalt()
    const b = createSalt()
    expect(a).not.toBe(b)
    expect(a).toHaveLength(32)
  })

  it('结果与标准 SHA-256(salt::pin) 一致', async () => {
    const salt = 'abcdef0123456789abcdef0123456789'
    const expected = createHash('sha256').update(`${salt}::4321`, 'utf8').digest('hex')
    expect(await hashPin('4321', salt)).toBe(expected)
  })

  it('没有 crypto.subtle 时（局域网 http）退回纯 JS 实现，结果完全一致', async () => {
    const salt = 'abcdef0123456789abcdef0123456789'
    const expected = createHash('sha256').update(`${salt}::1234`, 'utf8').digest('hex')

    // 模拟非安全上下文：crypto 存在，但没有 subtle
    vi.stubGlobal('crypto', {
      getRandomValues: (bytes: Uint8Array) => webcrypto.getRandomValues(bytes)
    })

    expect(globalThis.crypto.subtle).toBeUndefined()
    expect(await hashPin('1234', salt)).toBe(expected)

    // 盐的生成也要能继续工作
    expect(createSalt()).toHaveLength(32)
    // 这一路必须仍然区分不同 PIN
    expect(await hashPin('9999', salt)).not.toBe(expected)
  })

  it('subtle.digest 抛错时也能兜住', async () => {
    const salt = 'abcdef0123456789abcdef0123456789'
    const expected = createHash('sha256').update(`${salt}::1234`, 'utf8').digest('hex')
    vi.stubGlobal('crypto', {
      getRandomValues: (bytes: Uint8Array) => webcrypto.getRandomValues(bytes),
      subtle: {
        digest: () => Promise.reject(new Error('Operation is not supported'))
      }
    })
    expect(await hashPin('1234', salt)).toBe(expected)
  })
})
