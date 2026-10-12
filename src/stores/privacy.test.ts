import { beforeEach, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
const { get } = vi.hoisted(() => ({ get: vi.fn() }))
vi.mock('@/db', () => ({ kvGet: get, kvSet: vi.fn() }))
vi.mock('@/utils/pin', () => ({
  createSalt: () => 'salt',
  hashPin: async (pin: string) => (pin === '1234' ? 'hash' : 'wrong')
}))
import { usePrivacyStore } from './privacy'
beforeEach(() => {
  setActivePinia(createPinia())
  get.mockReset()
})
it('读取失败保持锁定，不能通过 verify 或设置新 PIN 绕过', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  get.mockRejectedValue(new Error('被占用'))
  const privacy = usePrivacyStore()
  try {
    await privacy.init()
    expect(privacy.locked).toBe(true)
    expect(privacy.loadFailed).toBe(true)
    expect(await privacy.verify('1234')).toBe(false)
    expect(await privacy.setPin('1234')).toBe(false)
  } finally {
    warn.mockRestore()
  }
})
it('重试成功后仍要求验证原有 PIN', async () => {
  const privacy = usePrivacyStore()
  privacy.loadFailed = true
  get.mockResolvedValue({ enabled: true, salt: 'salt', hash: 'hash' })
  await privacy.init()
  expect(privacy.loadFailed).toBe(false)
  expect(privacy.locked).toBe(true)
  expect(await privacy.verify('0000')).toBe(false)
  expect(privacy.locked).toBe(true)
  expect(await privacy.verify('1234')).toBe(true)
  expect(privacy.locked).toBe(false)
})
it('确认未设置锁后才放行', async () => {
  const privacy = usePrivacyStore()
  expect(privacy.locked).toBe(true)
  get.mockResolvedValue(undefined)
  await privacy.init()
  expect(privacy.locked).toBe(false)
})
