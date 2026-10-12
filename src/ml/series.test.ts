import { describe, expect, it } from 'vitest'
import { inspectSeries, parseSeries, sampleSeries } from './series'
describe('parseSeries 原有序列输入兼容', () => {
  it('逗号分隔', () => {
    expect(parseSeries('1, 2, 3, 4')).toEqual([1, 2, 3, 4])
  })
  it('换行与空格分隔', () => {
    expect(parseSeries('1\n2\n3')).toEqual([1, 2, 3])
    expect(parseSeries('1  2  3')).toEqual([1, 2, 3])
  })
  it('中文逗号与分号', () => {
    expect(parseSeries('1，2；3')).toEqual([1, 2, 3])
  })
  it('提取数值兼容旧调用，检查接口保留坏值位置', () => {
    expect(parseSeries('1, xyz, 2')).toEqual([1, 2])
    expect(inspectSeries('1, xyz, 2').issues[0].position).toBe(2)
  })
  it('支持负数与小数', () => {
    expect(parseSeries('-1.5, 2, 3.25')).toEqual([-1.5, 2, 3.25])
  })
  it('空输入返回空数组', () => {
    expect(parseSeries('')).toEqual([])
    expect(parseSeries('abc')).toEqual([])
  })
  it('示例长度足够基本训练', () => {
    expect(sampleSeries().length).toBeGreaterThanOrEqual(5)
  })
})
