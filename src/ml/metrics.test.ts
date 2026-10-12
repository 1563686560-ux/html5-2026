import { describe, expect, it } from 'vitest'
import { computeMetrics, mae, mape, mean, r2, rmse } from './metrics'

describe('回归评估指标', () => {
  it('rmse 完美预测为 0', () => {
    expect(rmse([1, 2, 3], [1, 2, 3])).toBe(0)
  })

  it('rmse 正确计算', () => {
    // 误差各为 1：sqrt((1+1+1)/3)
    expect(rmse([1, 2, 3], [2, 3, 4])).toBeCloseTo(1, 5)
  })

  it('mae 正确计算', () => {
    expect(mae([1, 2, 3], [2, 3, 4])).toBeCloseTo(1, 5)
  })

  it('mape 跳过 0 值', () => {
    // 实际 [10, 0, 5]，预测 [9, 99, 4]：误差 10%、(跳过 0)、20% → 均值 15%
    expect(mape([10, 0, 5], [9, 99, 4])).toBeCloseTo(15, 5)
  })

  it('r2 完美拟合为 1，纯常数预测为 0 附近', () => {
    expect(r2([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 5)
    const constant = mean([1, 2, 3])
    expect(r2([1, 2, 3], [constant, constant, constant])).toBeCloseTo(0, 5)
  })

  it('空输入返回 NaN', () => {
    expect(computeMetrics([], [])).toEqual({ rmse: NaN, mae: NaN, mape: NaN, r2: NaN })
  })
})
