import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { trainForecast } from './timeseries'
const { FakeWorker, workers } = vi.hoisted(() => {
  const workers: Array<{
    onmessage: ((event: { data: Record<string, unknown> }) => void) | null
    onerror: ((event: { message: string }) => void) | null
    terminate: ReturnType<typeof vi.fn>
    postMessage: ReturnType<typeof vi.fn>
  }> = []
  class FakeWorker {
    onmessage: ((event: { data: Record<string, unknown> }) => void) | null = null
    onerror: ((event: { message: string }) => void) | null = null
    terminate = vi.fn()
    postMessage = vi.fn()
    constructor() {
      workers.push(this)
    }
  }
  return { FakeWorker, workers }
})
vi.mock('./forecast.worker?worker', () => ({ default: FakeWorker }))
beforeEach(() => {
  workers.length = 0
  vi.stubGlobal('Worker', FakeWorker)
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
it('取消实际终止Worker，并移除回调', async () => {
  const controller = new AbortController()
  const pending = trainForecast([1, 2, 3], {}, { signal: controller.signal })
  const assertion = expect(pending).rejects.toThrow('已停止')
  controller.abort()
  await assertion
  expect(workers[0].terminate).toHaveBeenCalledTimes(1)
  expect(workers[0].onmessage).toBeNull()
  expect(vi.getTimerCount()).toBe(0)
})
it('工作线程一直无响应时有限等待并终止', async () => {
  const pending = trainForecast([1, 2, 3], {}, { timeoutMs: 50 })
  const assertion = expect(pending).rejects.toThrow('超过等待时间')
  await vi.advanceTimersByTimeAsync(50)
  await assertion
  expect(workers[0].terminate).toHaveBeenCalledTimes(1)
})
it('消息的任务编号必须匹配，成功后清理定时器', async () => {
  const pending = trainForecast([1, 2, 3])
  const worker = workers[0]
  const request = worker.postMessage.mock.calls[0][0]
  worker.onmessage?.({ data: { id: request.id + 1, type: 'done', result: { forecast: [999] } } })
  expect(worker.terminate).not.toHaveBeenCalled()
  worker.onmessage?.({ data: { id: request.id, type: 'done', result: { forecast: [4] } } })
  expect((await pending).forecast).toEqual([4])
  expect(vi.getTimerCount()).toBe(0)
})
it('发消息失败或Worker错误也终止，不保留挂起任务', async () => {
  const pending = trainForecast([1, 2, 3])
  const assertion = expect(pending).rejects.toThrow('测试错误')
  workers[0].onerror?.({ message: '测试错误' })
  await assertion
  expect(workers[0].terminate).toHaveBeenCalledTimes(1)
})
