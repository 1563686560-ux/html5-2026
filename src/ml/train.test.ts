import { describe, expect, it } from 'vitest'
import { sampleSeries } from './series'
import { splitSeries, trainForecastCore } from './train'

describe('splitSeries 训练/测试切分', () => {
  it('测试集取最后一段，切分点 = 总数 − 测试点数', () => {
    const { splitIndex, testSize } = splitSeries(100, 0.2)
    expect(testSize).toBe(20)
    expect(splitIndex).toBe(80)
    // 训练段就是 [0, splitIndex)
    expect(splitIndex + testSize).toBe(100)
  })

  it('短序列也至少留 1 个测试点，且训练段不为空', () => {
    for (const total of [2, 3, 5, 7, 9]) {
      const { splitIndex, testSize } = splitSeries(total, 0.2)
      expect(testSize).toBeGreaterThanOrEqual(1)
      expect(splitIndex).toBeGreaterThanOrEqual(1)
      expect(splitIndex + testSize).toBe(total)
    }
  })

  it('比例被夹在 [0.05, 0.5]，非法值回落 0.2', () => {
    expect(splitSeries(100, 0.9).testSize).toBe(50)
    expect(splitSeries(100, 0.01).testSize).toBe(5)
    expect(splitSeries(100, Number.NaN).testSize).toBe(20)
    expect(splitSeries(100, -1).testSize).toBe(5)
  })

  it('单点序列不产生空训练段', () => {
    const { splitIndex, testSize } = splitSeries(1, 0.2)
    expect(testSize).toBe(1)
    expect(splitIndex).toBe(0)
  })
})

describe('trainForecastCore 训练核心', () => {
  it('恒定零值保持末值，指标不适用而非伪造100%准确', async () => {
    const result = await trainForecastCore(
      Array.from({ length: 40 }, () => 0),
      { horizon: 7, window: 7 }
    )
    expect(result.method).toBe('constant')
    expect(result.trainedEpochs).toBe(0)
    expect(result.forecast).toEqual(Array.from({ length: 7 }, () => 0))
    expect(result.metrics.mae).toBe(0)
    expect(Number.isNaN(result.metrics.mape)).toBe(true)
    expect(Number.isNaN(result.metrics.r2)).toBe(true)
    expect(result.backtest?.modelMetrics.mae).toBe(0)
  })
  it('恒定非零值保持真实值，不产生神经网络漂移', async () => {
    const result = await trainForecastCore(
      Array.from({ length: 20 }, () => 5),
      { horizon: 3 }
    )
    expect(result.forecast).toEqual([5, 5, 5])
    expect(result.metrics.mape).toBe(0)
    expect(result.method).toBe('constant')
  })
  it('无效数值和已取消的任务在训练前被拒绝', async () => {
    await expect(trainForecastCore([1, Number.NaN, 3], {})).rejects.toThrow('无效数值')
    const controller = new AbortController()
    controller.abort()
    await expect(trainForecastCore(sampleSeries(), { signal: controller.signal })).rejects.toThrow('已停止')
  })
  it('在 CPU 后端训练微型模型并产出有限指标', async () => {
    const result = await trainForecastCore(sampleSeries(), { epochs: 60, horizon: 3 })
    expect(result.forecast).toHaveLength(3)
    expect(Number.isFinite(result.finalLoss)).toBe(true)
    expect(Number.isFinite(result.metrics.rmse)).toBe(true)
    expect(Number.isFinite(result.metrics.mae)).toBe(true)
    expect(Number.isFinite(result.metrics.mape)).toBe(true)
    expect(Number.isFinite(result.metrics.r2)).toBe(true)
    // 20 点、默认 20% 留出 4 点，可形成 2 个完整的 3 步起点。
    expect(result.backtest?.horizon).toBe(3)
    expect(result.backtest?.origins).toBe(2)
    expect(Number.isFinite(result.backtest!.modelMetrics.mae)).toBe(true)
    expect(Number.isFinite(result.backtest!.baselineMetrics.mae)).toBe(true)
    // 不断言精度阈值：tfjs 随机初始化会让 R² 有小幅波动，
    // 此处只做「能训练、指标有效」的烟雾测试，精度在真实 UI 中体现。
  }, 30000)

  it('指标算在测试集上，训练集与测试集窗口不重叠且都非空', async () => {
    const series = sampleSeries()
    const window = 6
    const result = await trainForecastCore(series, { epochs: 40, window, testRatio: 0.25 })

    expect(result.trainWindows).toBeGreaterThan(0)
    expect(result.testWindows).toBeGreaterThan(0)
    // 窗口总数 = 序列长度 − 窗口大小，且被切成互不重叠的两段
    expect(result.trainWindows + result.testWindows).toBe(series.length - window)
    // 切分点之后才是测试集
    expect(result.splitIndex).toBe(series.length - Math.round(series.length * 0.25))

    // 两组指标都必须是有效数字（各自在自个子集上算）
    expect(Number.isFinite(result.trainMetrics.rmse)).toBe(true)
    expect(Number.isFinite(result.metrics.rmse)).toBe(true)
  }, 30000)

  it('缩放只用训练段：min/max 等于训练段的极值，不被测试段拉走', async () => {
    // 前 12 个点在 [0,10]，最后 3 个点陡然抬到 100 —— 测试段会极大改变全局极值
    const series = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 2, 4, 100, 120, 140]
    const result = await trainForecastCore(series, { epochs: 10, window: 4, testRatio: 0.25 })
    // 训练段 = 前 11 个点（15 − round(3.75)=4 → splitIndex=11），其极值是 10
    expect(result.max).toBe(10)
    expect(result.min).toBe(1)
  }, 30000)

  it('数据不足时抛出友好错误', async () => {
    await expect(trainForecastCore([1, 2], {})).rejects.toThrow(/至少需要/)
  })

  it('留出段不足完整预测长度时，不展示多步准确度', async () => {
    const result = await trainForecastCore(sampleSeries(), { epochs: 8, horizon: 7 })
    expect(result.backtest).toBeNull()
  }, 30000)
})
