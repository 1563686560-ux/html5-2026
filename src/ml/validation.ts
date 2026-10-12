import { inspectSeries } from './series'

export const MAX_FORECAST_POINTS = 2000
export function minimumForecastPoints(window: number): number {
  let count = window + 3
  while (count - Math.round(count * 0.2) <= window) count++
  return count
}
export function validateForecastInput(raw: string, config: { window: number; horizon: number; epochs: number }) {
  const parsed = inspectSeries(raw)
  const errors: string[] = []
  const warnings: string[] = []
  for (const [key, label, min, max] of [
    ['window', '参考窗口', 2, 12],
    ['horizon', '预测步数', 1, 12],
    ['epochs', '训练轮数', 10, 500]
  ] as const) {
    const value = config[key]
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max)
      errors.push(`${label}请输入 ${min}～${max} 的整数。`)
  }
  const missing = parsed.issues.filter((issue) => issue.kind === 'missing')
  const invalid = parsed.issues.filter((issue) => issue.kind === 'invalid')
  if (missing.length)
    errors.push(
      `有 ${missing.length} 个缺失值（位置 ${missing
        .slice(0, 3)
        .map((issue) => issue.position)
        .join('、')}）。请补齐或修正原始数据，不能直接跳过时间点。`
    )
  if (invalid.length)
    errors.push(
      `有 ${invalid.length} 个非数值或无效值（位置 ${invalid
        .slice(0, 3)
        .map((issue) => issue.position)
        .join('、')}）。请选择数值列，移除表头、日期和单位文字；支持科学计数法。`
    )
  const minimum =
    Number.isInteger(config.window) && config.window >= 2 && config.window <= 12
      ? minimumForecastPoints(config.window)
      : 5
  if (!parsed.issues.length && parsed.values.length < minimum)
    errors.push(
      `当前 ${parsed.values.length} 个数据点，参考窗口 ${config.window} 至少需要 ${minimum} 个才能划分训练与测试数据。请补充数据或减小参考窗口。`
    )
  if (parsed.count > MAX_FORECAST_POINTS)
    errors.push(`手机端单次最多 ${MAX_FORECAST_POINTS} 个数据点，请截取连续的一段历史数据。`)
  if (parsed.values.some((value) => Math.abs(value) > 1e12))
    errors.push('存在绝对值超过 10¹² 的数值，请核对单位或缩小数值尺度后再预测。')
  if (parsed.values.length && !errors.length) {
    if (parsed.values.length < 30) warnings.push('历史少于 30 个点，预测仅供演示，建议补充更多连续历史。')
    const testSize = Math.round(parsed.values.length * 0.2)
    if (testSize < config.horizon)
      warnings.push(
        `留出历史只有 ${testSize} 个点，无法回测完整的 ${config.horizon} 步预测；建议至少提供 ${Math.ceil(config.horizon / 0.2)} 个点或缩短预测步数。`
      )
    if (parsed.values.every((value) => value === parsed.values[0]))
      warnings.push('数据全部相同，将保持当前值外推，不训练神经网络；没有足够变化来评估趋势。')
    else {
      const sorted = [...parsed.values].sort((a, b) => a - b)
      const median = sorted[Math.floor(sorted.length / 2)]
      const deviations = sorted.map((value) => Math.abs(value - median)).sort((a, b) => a - b)
      const mad = deviations[Math.floor(deviations.length / 2)]
      const outliers =
        mad > 0
          ? parsed.values.filter((value) => Math.abs(value - median) > 8 * mad).length
          : parsed.values.filter((value) => value !== median).length
      if (outliers)
        warnings.push(`有 ${outliers} 个值明显偏离主体范围，可能是真实突变或录入异常。原值会保留，请核对后再预测。`)
    }
  }
  return { ...parsed, errors, warnings, minimum, canRun: errors.length === 0 }
}
