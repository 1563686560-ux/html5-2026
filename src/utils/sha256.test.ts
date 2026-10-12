import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { sha256Hex } from './sha256'

function nodeSha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

const encoder = new TextEncoder()

describe('纯 JS SHA-256', () => {
  it('标准测试向量', () => {
    expect(sha256Hex(encoder.encode(''))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    )
    expect(sha256Hex(encoder.encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    )
    expect(sha256Hex(encoder.encode('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'
    )
    expect(sha256Hex(encoder.encode('a'.repeat(1_000_000)))).toBe(
      'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0'
    )
  })

  it('与 node:crypto 在填充边界附近逐个长度一致', () => {
    // 55/56/63/64 是关键边界：补位字节正好跨块，写错就会在这里露馅
    const lengths = [0, 1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 121, 127, 128, 129, 200]
    for (const length of lengths) {
      const text = 'x'.repeat(length)
      expect(sha256Hex(encoder.encode(text)), `长度 ${length}`).toBe(nodeSha256(text))
    }
  })

  it('中文与 emoji 按 UTF-8 字节处理', () => {
    for (const text of ['先贤对话', 'abcdef', '你好，世界！🌏', 'AI 智囊团 · 问数']) {
      expect(sha256Hex(encoder.encode(text)), text).toBe(nodeSha256(text))
    }
  })

  it('输出恒为 64 位十六进制', () => {
    expect(sha256Hex(encoder.encode('任意内容'))).toMatch(/^[0-9a-f]{64}$/)
  })
})
