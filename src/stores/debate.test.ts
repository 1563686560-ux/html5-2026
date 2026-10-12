import { beforeEach, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const { stream, settings } = vi.hoisted(() => ({
  stream: vi.fn(),
  settings: { chatConfigured: true, api: { chat: { baseUrl: 'https://test.invalid', model: 'test', apiKey: 'test' } } }
}))
vi.mock('@/api/llm', () => ({ streamChat: stream }))
vi.mock('./settings', () => ({ useSettingsStore: () => settings }))
vi.mock('@/utils/frameBatcher', () => ({
  createFrameBatcher: (write: (value: string) => void) => ({ push: write, flush: vi.fn() })
}))
import { useDebateStore } from './debate'

beforeEach(() => {
  setActivePinia(createPinia())
  stream.mockReset().mockImplementation(async (_endpoint, _messages, options) => {
    options.onDelta('发言', '完整发言')
    options.onFinish?.({ truncated: false })
  })
})

it('双方收到明确且相反的立场，第二位能看到第一位发言', async () => {
  const store = useDebateStore()
  store.topic = '人工智能能理解人类情感'
  store.rounds = 1
  await store.run()
  expect(stream.mock.calls[0]?.[1][0].content).toContain('正方，必须支持')
  expect(stream.mock.calls[0]?.[1][0].content).toContain('最多220字')
  expect(stream.mock.calls[1]?.[1][0].content).toContain('反方，必须反对')
  expect(stream.mock.calls[1]?.[1][1].content).toContain('完整发言')
  expect(store.finished).toBe(true)
  expect(store.completedCount).toBe(2)
})

it('同一辩手被拦截且不调用模型', async () => {
  const store = useDebateStore()
  store.topic = '辩题'
  store.bId = store.aId
  await store.run()
  expect(stream).not.toHaveBeenCalled()
  expect(store.errorText).toContain('不同')
})

it('失败后只重试未完成发言，保存已完成发言与原辩题', async () => {
  stream
    .mockImplementationOnce(async (_endpoint, _messages, options) => options.onDelta('第一位', '第一位完整观点'))
    .mockImplementationOnce(async (_endpoint, _messages, options) => {
      options.onDelta('半截', '半截观点')
      throw new Error('服务繁忙')
    })
  const store = useDebateStore()
  store.topic = '原辩题'
  store.rounds = 1
  await store.run()
  const firstId = store.turns[0]!.id
  expect(store.canResume).toBe(true)
  expect(store.completedCount).toBe(1)
  store.topic = '更改后的辩题'
  await store.run(true)
  expect(stream).toHaveBeenCalledTimes(3)
  expect(store.turns[0]!.id).toBe(firstId)
  expect(stream.mock.calls[2]?.[1][0].content).toContain('原辩题')
  expect(stream.mock.calls[2]?.[1][1].content).not.toContain('半截观点')
  expect(store.turns).toHaveLength(2)
  expect(store.finished).toBe(true)
})

it('主动停止与截断响应都保留继续入口，不冒充完成', async () => {
  stream.mockImplementationOnce(async (_endpoint, _messages, options) => {
    options.onDelta('半截', '半截')
    options.onFinish({ truncated: true })
  })
  const store = useDebateStore()
  store.topic = '辩题'
  store.rounds = 1
  await store.run()
  expect(store.finished).toBe(false)
  expect(store.completedCount).toBe(0)
  expect(store.canResume).toBe(true)
  stream.mockImplementationOnce(async (_endpoint, _messages, options) => {
    store.stop()
    options.signal.throwIfAborted()
  })
  await store.run(true)
  expect(store.canResume).toBe(true)
  expect(store.errorText).toBeNull()
})
