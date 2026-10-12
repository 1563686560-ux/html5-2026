/** 纯序列工具：解析与示例数据。与 tfjs 解耦，方便单元测试。 */

export interface SeriesIssue {
  position: number
  token: string
  kind: 'missing' | 'invalid'
}
export interface ParsedSeries {
  values: number[]
  issues: SeriesIssue[]
  count: number
}
export function isSeriesNumber(token: string): boolean {
  return /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(token) && Number.isFinite(Number(token))
}

/** 不删字符或补数：记录坏值/缺失位置，训练前必须由调用方检查 issues。 */
export function inspectSeries(raw: string): ParsedSeries {
  const source = raw
    .normalize('NFKC')
    .trim()
    .replace(/\r\n?/g, '\n')
    .replace(/,[ \t]*\n/g, ',')
  if (!source) return { values: [], issues: [], count: 0 }
  const groups: string[] = []
  let group = ''
  let quoted = false
  for (const char of source) {
    if (char === '"') quoted = !quoted
    if (!quoted && /[,;\t\r\n]/.test(char)) {
      groups.push(group)
      group = ''
    } else group += char
  }
  groups.push(group)
  const tokens = groups.flatMap((value) => (value.trim() ? (value.match(/"(?:[^"\\]|\\.)*"|\S+/g) ?? [value]) : ['']))
  const values: number[] = []
  const issues: SeriesIssue[] = []
  tokens.forEach((token, index) => {
    if (isSeriesNumber(token)) values.push(Number(token))
    else issues.push({ position: index + 1, token, kind: token ? 'invalid' : 'missing' })
  })
  return { values, issues, count: tokens.length }
}

/** 兼容数值提取调用；预测入口使用 inspectSeries，禁止静默跳过坏值。 */
export function parseSeries(raw: string): number[] {
  return inspectSeries(raw).values
}

/** 生成一段演示数据，方便答辩时一键演示 */
export function sampleSeries(): number[] {
  return [42, 45, 44, 48, 52, 51, 55, 59, 58, 63, 66, 68, 71, 74, 73, 79, 82, 85, 88, 91]
}
