export type SamplingPeriod = 'step' | 'hour' | 'day' | 'week' | 'month'
export const SAMPLING_PERIODS = {
  step: '按序号（周期未知）',
  hour: '每小时',
  day: '每天',
  week: '每周',
  month: '每月'
} as const
export function periodUnit(period: SamplingPeriod): string {
  return { step: '步', hour: '小时', day: '天', week: '周', month: '个月' }[period]
}
export function formatMetric(value: number | undefined | null, digits = 2, suffix = ''): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  return `${Math.abs(value) >= 1e6 ? value.toExponential(2) : value.toFixed(digits)}${suffix}`
}
export function formatValue(value: number): string {
  if (!Number.isFinite(value)) return '—'
  if ((Math.abs(value) > 0 && Math.abs(value) < 0.01) || Math.abs(value) >= 1e6) return value.toExponential(2)
  return Number(value.toFixed(2)).toString()
}
export function explainTrend(actual: number[], forecast: number[], period: SamplingPeriod, unit: string): string {
  const current = actual.at(-1)
  const future = forecast.at(-1)
  if (current === undefined || future === undefined || !Number.isFinite(current) || !Number.isFinite(future))
    return '当前无法解释这组预测，请重新检查数据。'
  const delta = future - current
  const relative = current === 0 ? null : (delta / Math.abs(current)) * 100
  const comparison =
    relative === null || !Number.isFinite(relative)
      ? `末值从 ${formatValue(current)} 变为 ${formatValue(future)}${unit ? ` ${unit}` : ''}；基数为零或过小，不能计算变化百分比`
      : `末值较最新历史点${Math.abs(relative) <= 2 ? '基本接近' : delta > 0 ? '上升' : '下降'}，变化 ${formatMetric(Math.abs(relative), 1)}%`
  return `未来 ${forecast.length} ${periodUnit(period)}的最后一个预测点：${comparison}。这是首尾对比，不表示中途持续同向变化，也不保证未来实际表现。`
}
