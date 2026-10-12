/** 生成短 ID：优先用 crypto.randomUUID，不支持时降级为随机串 */
export function createId(prefix = ''): string {
  let core: string
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    core = crypto.randomUUID().replace(/-/g, '').slice(0, 12)
  } else {
    core = Math.random().toString(36).slice(2, 8) + Date.now().toString(36)
  }
  return prefix ? `${prefix}_${core}` : core
}
