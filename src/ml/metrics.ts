/** 回归评估指标（纯函数，便于单测） */

export interface RegressionMetrics {
  rmse: number
  mae: number
  mape: number
  r2: number
}

export function mean(values: number[]): number {
  if (values.length === 0) return Number.NaN
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

export function rmse(actual: number[], predicted: number[]): number {
  const n = Math.min(actual.length, predicted.length)
  if (n === 0) return Number.NaN
  const sumSq = actual.slice(0, n).reduce((sum, value, index) => sum + (value - predicted[index]) ** 2, 0)
  return Math.sqrt(sumSq / n)
}

export function mae(actual: number[], predicted: number[]): number {
  const n = Math.min(actual.length, predicted.length)
  if (n === 0) return Number.NaN
  const sum = actual.slice(0, n).reduce((sum, value, index) => sum + Math.abs(value - predicted[index]), 0)
  return sum / n
}

/** 平均绝对百分比误差（%）。跳过实际值为 0 的点，避免除零。 */
export function mape(actual: number[], predicted: number[]): number {
  const n = Math.min(actual.length, predicted.length)
  let sum = 0
  let count = 0
  for (let i = 0; i < n; i++) {
    if (actual[i] === 0) continue
    sum += Math.abs((actual[i] - predicted[i]) / actual[i])
    count += 1
  }
  return count === 0 ? Number.NaN : (sum / count) * 100
}

/** 决定系数 R²，越接近 1 拟合越好 */
export function r2(actual: number[], predicted: number[]): number {
  const n = Math.min(actual.length, predicted.length)
  if (n < 2) return Number.NaN
  const avg = mean(actual.slice(0, n))
  let ssRes = 0
  let ssTot = 0
  for (let i = 0; i < n; i++) {
    ssRes += (actual[i] - predicted[i]) ** 2
    ssTot += (actual[i] - avg) ** 2
  }
  return ssTot === 0 ? Number.NaN : 1 - ssRes / ssTot
}

export function computeMetrics(actual: number[], predicted: number[]): RegressionMetrics {
  return {
    rmse: rmse(actual, predicted),
    mae: mae(actual, predicted),
    mape: mape(actual, predicted),
    r2: r2(actual, predicted)
  }
}
