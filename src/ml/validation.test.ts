import { describe, expect, it } from 'vitest'
import { inspectSeries, parseSeries } from './series'
import { csvColumnText, parseCsv } from './csv'
import { validateForecastInput, minimumForecastPoints } from './validation'
const config = { window: 7, horizon: 7, epochs: 160 }
const series = Array.from({ length: 40 }, (_, i) => i + 1).join(',')

describe('预测数据检查', () => {
  it('单列CSV中间空行保留为缺失位置，首行千分位数值不误当表头', () => {
    expect(inspectSeries(csvColumnText(parseCsv('值\n1\n\n3'), 0)).issues[0].position).toBe(2)
    expect(parseCsv('"1,000"\n"2,000"').rows).toHaveLength(2)
  })
  it('科学计数法、正负小数和中文分隔符保持原值', () => {
    expect(inspectSeries('1e3，-2.5；+3 .4').values).toEqual([1000, -2.5, 3, 0.4])
    expect(inspectSeries('1e3，-2.5；+3 .4').issues).toEqual([])
  })
  it.each(['1,,3', ',1,2', '1,2,', '1\n\n3'])('记录缺失位置，不压缩时间轴：%s', (raw) => {
    expect(inspectSeries(raw).issues.some((issue) => issue.kind === 'missing')).toBe(true)
    expect(validateForecastInput(raw, config).canRun).toBe(false)
  })
  it('支持CRLF和逗号后换行的正常排版', () => {
    expect(inspectSeries('1\r\n2\r\n3').issues).toEqual([])
    expect(inspectSeries('1,\n2,\n3').issues).toEqual([])
  })
  it.each(['2026-10-09', '12元', 'NaN', 'Infinity', '1e309', '12%'])('不从坏值中偷取数字：%s', (raw) => {
    expect(parseSeries(raw)).toEqual([])
    expect(inspectSeries(raw).issues).toHaveLength(1)
  })
  it('CSV千分位保持一个点，多值或日期单元格保持为错误', () => {
    expect(inspectSeries(csvColumnText(parseCsv('值\n"1,000"\n"2,500"'), 0)).values).toEqual([1000, 2500])
    const inspected = inspectSeries(csvColumnText(parseCsv('值\n"12 34"\n2026-10-09\n5'), 0))
    expect(inspected.values).toEqual([5])
    expect(inspected.issues).toHaveLength(2)
  })
  it('缺失CSV行不可静默进入训练', () => {
    const raw = csvColumnText(parseCsv('日期,值\na,10\nb,\nc,30'), 1)
    expect(inspectSeries(raw).issues[0].position).toBe(2)
    expect(validateForecastInput(raw, config).canRun).toBe(false)
  })
  it('输入清空或非法高级参数，明确拒绝训练', () => {
    expect(validateForecastInput('', config).canRun).toBe(false)
    expect(validateForecastInput(series, { ...config, horizon: '' as unknown as number }).canRun).toBe(false)
    expect(validateForecastInput(series, { ...config, epochs: 2.5 }).canRun).toBe(false)
  })
  it('最短长度满足窗口与时间顺序留出条件', () => {
    expect(minimumForecastPoints(7)).toBe(10)
    expect(minimumForecastPoints(12)).toBe(16)
    expect(validateForecastInput('1,2,3,4,5', config).errors.join()).toContain('至少需要 10')
    expect(validateForecastInput(series, config).canRun).toBe(true)
  })
  it('极端尺度和过多点数不启动模型', () => {
    expect(validateForecastInput(`${series},1e13`, config).canRun).toBe(false)
    expect(validateForecastInput(Array.from({ length: 2001 }, () => 1).join(','), config).canRun).toBe(false)
  })
  it('常量、少历史、无法完整回测和明显异常只提示，不篡改数据', () => {
    expect(validateForecastInput(Array.from({ length: 20 }, () => 0).join(','), config).warnings.join()).toContain(
      '全部相同'
    )
    expect(validateForecastInput(Array.from({ length: 20 }, (_, i) => i).join(','), config).warnings.join()).toContain(
      '无法回测'
    )
    const check = validateForecastInput(`${series},10000`, config)
    expect(check.canRun).toBe(true)
    expect(check.values.at(-1)).toBe(10000)
    expect(check.warnings.join()).toContain('偏离主体范围')
  })
})
