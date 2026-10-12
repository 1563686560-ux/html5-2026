import { describe, expect, it } from 'vitest'
import { computeVirtualWindow } from './useVirtualList'

const ROW = 60

describe('computeVirtualWindow 可见区间计算', () => {
  it('空列表不渲染任何行，也不留占位', () => {
    expect(computeVirtualWindow(0, ROW, 0, 400)).toEqual({ start: 0, end: 0, padTop: 0, padBottom: 0 })
  })

  it('行高非法时直接返回空区间（防止除零）', () => {
    expect(computeVirtualWindow(100, 0, 0, 400)).toEqual({ start: 0, end: 0, padTop: 0, padBottom: 0 })
  })

  it('未滚动时从第一行开始，且底部占位撑满剩余高度', () => {
    // 视口 400px / 行高 60 = 可见约 7 行，overscan 默认 4
    const w = computeVirtualWindow(100, ROW, 0, 400, 4)
    expect(w.start).toBe(0)
    expect(w.end).toBe(11) // ceil(400/60)=7，再加 4 行 overscan
    expect(w.padTop).toBe(0)
    expect(w.padBottom).toBe((100 - 11) * ROW)
  })

  it('上下占位与可见行数之和恒等于总高度', () => {
    for (const scrollTop of [0, 137, 600, 3000, 99999]) {
      const w = computeVirtualWindow(200, ROW, scrollTop, 500, 3)
      const rendered = (w.end - w.start) * ROW
      expect(w.padTop + rendered + w.padBottom).toBe(200 * ROW)
    }
  })

  it('滚动到底部时不越界，且底部占位为 0', () => {
    const total = 50
    const viewport = 400
    const maxScroll = total * ROW - viewport
    const w = computeVirtualWindow(total, ROW, maxScroll, viewport, 4)
    expect(w.end).toBe(total)
    expect(w.padBottom).toBe(0)
    expect(w.start).toBeLessThan(total)
  })

  it('滚动超过内容高度（惯性回弹）也不越界', () => {
    const w = computeVirtualWindow(20, ROW, 999999, 400, 4)
    expect(w.end).toBe(20)
    expect(w.padBottom).toBe(0)
    expect(w.padTop).toBeLessThanOrEqual((20 - 1) * ROW)
  })

  it('行数少于视口容量时全部渲染', () => {
    const w = computeVirtualWindow(3, ROW, 0, 400, 4)
    expect(w.start).toBe(0)
    expect(w.end).toBe(3)
    expect(w.padBottom).toBe(0)
  })

  it('视口高度未知时（首帧）也至少渲染若干行，不白屏', () => {
    const w = computeVirtualWindow(100, ROW, 0, 0, 4)
    expect(w.end).toBeGreaterThan(0)
    expect(w.end - w.start).toBeGreaterThanOrEqual(4)
  })

  it('overscan 为 0 时只渲染真正可见的行', () => {
    const w = computeVirtualWindow(100, ROW, 600, 400, 0)
    expect(w.start).toBe(10) // 600 / 60
    expect(w.end).toBe(17) // ceil((600+400)/60) = 17
  })
})
