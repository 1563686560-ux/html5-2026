/**
 * 写入 IndexedDB 前的「去响应式代理」处理
 * ------------------------------------------------------------------
 * 背景（这是一个真实踩过的坑）：
 *   IndexedDB 通过结构化克隆保存数据，而 Vue 的 `ref` / `reactive`
 *   返回的是 Proxy。把 Proxy 直接交给 `store.put()` 会抛
 *   `DataCloneError: could be cloned`。
 *
 *   项目里早期是靠「每个调用点自己记得展开」来规避的，例如
 *   `dbPut(STORE.sessions, { ...session })`。这依赖人工记忆，
 *   privacy.ts 就漏了一次，导致隐私锁设置完刷新就丢。
 *
 * 解决：
 *   在数据层统一兜住，写入前递归还原成普通数据。这样任何调用点
 *   传响应式对象都不会再炸，配合 `dbPut` / `kvSet` 自动生效。
 *
 * 实现要点：
 *   - 用 `toRaw` 拆代理，递归只重建「普通对象 / 数组 / Map / Set」，
 *     其余（Date、TypedArray、Blob…）原样返回，保持可克隆性；
 *   - 响应式的目标对象里存的本来就是原始值（Vue 只在读取时包代理），
 *     所以「没有代理」的子树会被完整保留，不会多复制一份。
 */
import { isProxy, isRef, toRaw } from 'vue'

/** 递归深度上限，防御自引用结构 */
const MAX_DEPTH = 32

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function unwrap(value: unknown, depth: number): unknown {
  if (value === null || typeof value !== 'object') return value
  if (depth > MAX_DEPTH) return value
  if (isRef(value)) return unwrap(value.value, depth + 1)

  const raw = isProxy(value) ? toRaw(value) : value

  if (Array.isArray(raw)) return raw.map((item) => unwrap(item, depth + 1))

  if (raw instanceof Map) {
    const map = new Map<unknown, unknown>()
    raw.forEach((item, key) => map.set(unwrap(key, depth + 1), unwrap(item, depth + 1)))
    return map
  }

  if (raw instanceof Set) {
    const set = new Set<unknown>()
    raw.forEach((item) => set.add(unwrap(item, depth + 1)))
    return set
  }

  if (isPlainObject(raw)) {
    const target = raw as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(target)) {
      const item = unwrap(target[key], depth + 1)
      // '__proto__' 直接赋值会改原型而不是加属性，必须显式定义
      if (key === '__proto__') {
        Object.defineProperty(out, key, { value: item, enumerable: true, writable: true, configurable: true })
      } else {
        out[key] = item
      }
    }
    return out
  }

  return raw
}

/** 把可能带 Vue 响应式代理的数据还原成可结构化克隆的普通数据 */
export function toPlain<T>(value: T): T {
  return unwrap(value, 0) as T
}
