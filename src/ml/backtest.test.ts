import { describe, expect, it } from 'vitest'
import { rollingBacktest } from './backtest'

describe('rollingBacktest 多步回测', () => {
  it('每个起点只向预测器提供当时已知的数据，且与末值基线比较相同目标', () => {
    const histories: number[][] = []
    const result = rollingBacktest([10, 11, 12, 13, 14, 15], 3, 2, (known, steps) => {
      histories.push(known)
      return Array(steps).fill(known.at(-1))
    })

    expect(histories).toEqual([
      [10, 11, 12],
      [10, 11, 12, 13]
    ])
    expect(result?.origins).toBe(2)
    expect(result?.comparisons).toBe(4)
    expect(result?.modelMetrics.mae).toBe(result?.baselineMetrics.mae)
  })

  it('预测明显优于末值基线时，误差比较能反映出来', () => {
    const result = rollingBacktest([1, 2, 3, 4, 5, 6, 7], 4, 2, (known, steps) =>
      Array.from({ length: steps }, (_, index) => known.at(-1)! + index + 1)
    )
    expect(result?.modelMetrics.mae).toBe(0)
    expect(result?.baselineMetrics.mae).toBeGreaterThan(0)
  })

  it('留出数据不足一个完整预测区间时不伪造回测结果', () => {
    expect(rollingBacktest([1, 2, 3, 4], 3, 2, () => [4, 5])).toBeNull()
  })

  it('预测器返回不完整或非有限结果时拒绝评估', () => {
    expect(() => rollingBacktest([1, 2, 3, 4], 2, 2, () => [3])).toThrow(/有效/)
    expect(() => rollingBacktest([1, 2, 3, 4], 2, 2, () => [3, NaN])).toThrow(/有效/)
  })
})
