/** 本地隐私 PIN 工具：只保存 SHA-256 摘要，不保存明文 PIN */
import { sha256Hex } from './sha256'

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('')
}

/** 生成 16 字节随机盐（十六进制字符串） */
export function createSalt(): string {
  const bytes = new Uint8Array(16)
  const source = globalThis.crypto
  if (source && typeof source.getRandomValues === 'function') {
    source.getRandomValues(bytes)
  } else {
    // 极老的浏览器兜底：没有 getRandomValues 时退回 Math.random
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256)
  }
  return toHex(bytes)
}

/**
 * 计算 PIN 摘要。
 * 优先用 WebCrypto（快、原生），但 `crypto.subtle` 只存在于安全上下文
 * （HTTPS / localhost）；局域网 http 真机调试时为 undefined，
 * 这时退回纯 JS 的 SHA-256，保证隐私锁在任何环境下都能用。
 */
export async function hashPin(pin: string, salt: string): Promise<string> {
  const data = new TextEncoder().encode(`${salt}::${pin}`)
  const subtle = globalThis.crypto?.subtle
  if (subtle) {
    try {
      const digest = await subtle.digest('SHA-256', data)
      return toHex(new Uint8Array(digest))
    } catch {
      // 某些内嵌浏览器里 subtle 存在但调用被拒，继续走下面的纯 JS 实现
    }
  }
  return sha256Hex(data)
}
