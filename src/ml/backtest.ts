import { computeMetrics, type RegressionMetrics } from './metrics'

export interface RollingBacktest {
  horizon: number
  origins: number
  comparisons: number
  modelMetrics: RegressionMetrics
  baselineMetrics: RegressionMetrics
}

/**
 * 在留出段的每个可用起点，模拟一次完整的多步预测。
 * 每次只把该起点之前已经发生的数据交给预测器；相邻起点的目标会重叠，
 * 因此 comparisons 是误差对数，不是独立样本数。
 */
export function rollingBacktest(
  series: number[],
  splitIndex: number,
  horizon: number,
  predict: (known: number[], steps: number) => number[]
): RollingBacktest | null {
  if (!Number.isInteger(horizon) || horizon < 1 || splitIndex < 1 || series.length - splitIndex < horizon) return null

  const actual: number[] = []
  const model: number[] = []
  const baseline: number[] = []
  let origins = 0

  for (let origin = splitIndex; origin + horizon <= series.length; origin++) {
    const known = series.slice(0, origin)
    const forecast = predict(known, horizon)
    if (forecast.length !== horizon || forecast.some((value) => !Number.isFinite(value))) {
      throw new Error('模型回测未产生有效的多步预测')
    }
    actual.push(...series.slice(origin, origin + horizon))
    model.push(...forecast)
    baseline.push(...Array.from({ length: horizon }, () => known[known.length - 1]))
    origins++
  }

  return {
    horizon,
    origins,
    comparisons: actual.length,
    modelMetrics: computeMetrics(actual, model),
    baselineMetrics: computeMetrics(actual, baseline)
  }
}
