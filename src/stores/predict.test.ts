import { beforeEach, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { trainForecast } from '@/ml/timeseries'
import { usePredictStore } from './predict'

vi.mock('@/ml/timeseries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/ml/timeseries')>()
  return { ...actual, trainForecast: vi.fn() }
})

const train = vi.mocked(trainForecast)
const metrics = { rmse: 1, mae: 1, mape: 5, r2: 0.8 }
const outcome = {
  finalLoss: 0.1,
  min: 1,
  max: 5,
  scaled: [0, 0.25, 0.5, 0.75, 1],
  trainedEpochs: 10,
  validationLoss: 0.2,
  forecast: [6, 7],
  fitted: [1, 2, 3, 4, 5],
  metrics,
  trainMetrics: metrics,
  splitIndex: 3,
  trainWindows: 2,
  testWindows: 1,
  backtest: null
}

beforeEach(() => {
  setActivePinia(createPinia())
  train
    .mockReset()
    .mockImplementation(async (_, config) => ({
      ...outcome,
      forecast: Array.from({ length: config?.horizon ?? 7 }, (_, index) => 6 + index)
    }))
})

it('切换页面使用同一会话状态，输入或参数变化后不展示旧结果', async () => {
  const firstPage = usePredictStore()
  firstPage.config.horizon = 2
  firstPage.input = '1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12'
  await firstPage.run()

  const returnedPage = usePredictStore()
  expect(returnedPage).toBe(firstPage)
  expect(returnedPage.result?.forecast).toEqual([6, 7])
  expect(returnedPage.result?.actual).toHaveLength(12)

  returnedPage.config.horizon = 4
  expect(returnedPage.result).toBeNull()
  await returnedPage.run()
  expect(returnedPage.result).not.toBeNull()
  returnedPage.input = '2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13'
  expect(returnedPage.result).toBeNull()
})

it('训练期间换数据，不把旧数据的结果写回新页面', async () => {
  let complete!: (value: typeof outcome) => void
  train.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve
      })
  )
  const store = usePredictStore()
  store.config.horizon = 2
  store.input = '1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12'
  const pending = store.run()
  expect(store.busy).toBe(true)

  store.input = '6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17'
  complete(outcome)
  await pending
  expect(store.result).toBeNull()
  expect(store.busy).toBe(false)
})

it('缺失或无效值不交给模型，参数不足时给出窗口对应提示', async () => {
  const store = usePredictStore()
  store.input = '1, 2, , 4, 5, 6, 7, 8, 9, 10, 11, 12'
  await store.run()
  expect(store.error).toContain('缺失值')
  expect(train).not.toHaveBeenCalled()
  store.input = '1,2,3,4,5'
  await store.run()
  expect(store.error).toContain('至少需要 10')
  expect(train).not.toHaveBeenCalled()
})

it('停止后可以立即开始新任务，旧任务不能覆盖新进度或结果', async () => {
  let complete!: (value: typeof outcome) => void
  train.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve
      })
  )
  const store = usePredictStore()
  store.input = Array.from({ length: 20 }, (_, i) => i + 1).join(',')
  store.config.horizon = 2
  const old = store.run()
  const signal = train.mock.calls[0][2]?.signal
  store.cancel()
  expect(signal?.aborted).toBe(true)
  expect(store.busy).toBe(false)
  await store.run()
  const current = store.result
  complete({ ...outcome, forecast: [99, 99] })
  await old
  expect(store.result).toBe(current)
  expect(store.result?.forecast).toEqual([6, 7])
})

it('修改后再恢复原输入，仍不接受之前取消的结果', async () => {
  let complete!: (value: typeof outcome) => void
  train.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve
      })
  )
  const store = usePredictStore()
  const raw = Array.from({ length: 20 }, (_, i) => i + 1).join(',')
  store.input = raw
  const pending = store.run()
  store.input = `${raw},21`
  store.input = raw
  complete(outcome)
  await pending
  expect(store.result).toBeNull()
  expect(store.busy).toBe(false)
})

it('修改周期或单位，清除原结果但保留输入', async () => {
  const store = usePredictStore()
  store.input = Array.from({ length: 20 }, (_, i) => i + 1).join(',')
  await store.run()
  store.samplingPeriod = 'month'
  expect(store.result).toBeNull()
  await store.run()
  store.valueUnit = '元'
  expect(store.result).toBeNull()
  expect(store.points).toHaveLength(20)
})

it.each([[Number.NaN, 7], [6, Number.POSITIVE_INFINITY], [6]])(
  '拒绝无效或长度不一致的模型输出 %j',
  async (...values) => {
    const forecast = values.flat() as number[]
    train.mockResolvedValueOnce({ ...outcome, forecast })
    const store = usePredictStore()
    store.input = Array.from({ length: 20 }, (_, i) => i + 1).join(',')
    store.config.horizon = 2
    await store.run()
    expect(store.result).toBeNull()
    expect(store.error).toContain('无效')
    expect(store.busy).toBe(false)
  }
)
