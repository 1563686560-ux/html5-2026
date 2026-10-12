import { expect, it } from 'vitest'
import { explainTrend, formatMetric, formatValue, periodUnit } from './presentation'
it('周期未知默认按步；月度数据用个月', () => {
  expect(periodUnit('step')).toBe('步')
  expect(periodUnit('month')).toBe('个月')
})
it('起点为零时不编造百分比和稳定趋势', () => {
  const explanation = explainTrend([0], [2, 10], 'day', '元')
  expect(explanation).toContain('从 0 变为 10 元')
  expect(explanation).toContain('不能计算变化百分比')
  expect(explanation).not.toContain('0.0%')
})
it('只解释末值对比，不把中间波动误判为持续上升', () => {
  const explanation = explainTrend([10], [100, -10, 20], 'month', '')
  expect(explanation).toContain('3 个月')
  expect(explanation).toContain('不表示中途持续同向变化')
})
it('负基数与微小数仍有可读解释', () => {
  expect(explainTrend([-10], [-5], 'hour', '°C')).toContain('上升')
  expect(formatValue(0.000001)).toBe('1.00e-6')
})
it('不适用指标用破折号，避免NaN、Infinity或伪百分比', () => {
  expect(formatMetric(Number.NaN, 1, '%')).toBe('—')
  expect(formatMetric(Number.POSITIVE_INFINITY)).toBe('—')
  expect(formatMetric(0, 1, '%')).toBe('0.0%')
})
it('近零基数和大指标不会产生Infinity百分比或撑破手机卡片', () => {
  expect(explainTrend([1e-320], [100], 'step', '')).toContain('不能计算变化百分比')
  expect(formatMetric(1e10)).toBe('1.00e+10')
})
