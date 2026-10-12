import { describe, expect, it } from 'vitest'
import { CANVAS_LIMITS, canvasSize, fitScale } from './exportImage'

const { maxLogicalHeight, maxDeviceDim, maxDeviceArea, minScale } = CANVAS_LIMITS

/** 直接用被测的真实尺寸计算函数，避免测试里再抄一份换算逻辑 */
function canvasOf(logicalHeight: number, preferred: number): { w: number; h: number; scale: number } {
  const size = canvasSize(logicalHeight, preferred)
  return { w: size.width, h: size.height, scale: size.scale }
}

describe('导出长图：画布尺寸必须落在浏览器限制内', () => {
  it('短会话保持期望清晰度', () => {
    expect(fitScale(1000, 3)).toBe(3)
    expect(fitScale(1000, 2)).toBe(2)
  })

  it('缩放系数绝不会超过期望值，也不会低于下限', () => {
    for (const height of [500, 2000, 4000, 7000, 40000]) {
      for (const preferred of [1, 2, 2.5, 3]) {
        const scale = fitScale(height, preferred)
        expect(scale, `h=${height} p=${preferred}`).toBeLessThanOrEqual(preferred)
        expect(scale, `h=${height} p=${preferred}`).toBeGreaterThanOrEqual(minScale)
      }
    }
  })

  it('任何高度下都不超单边上限与面积上限（含 iPhone dpr=3）', () => {
    // 7000 逻辑高度 × 3 倍曾经会开出 2250 × 21000 的画布，直接是空白图
    for (const dpr of [1, 2, 3]) {
      for (const height of [500, 1500, 2485, 3000, 4000, 5000, 7000, 20000]) {
        const { w, h } = canvasOf(height, Math.min(Math.max(dpr, 2), 3))
        expect(w, `dpr=${dpr} h=${height} 宽度`).toBeLessThanOrEqual(maxDeviceDim)
        expect(h, `dpr=${dpr} h=${height} 高度`).toBeLessThanOrEqual(maxDeviceDim)
        expect(w * h, `dpr=${dpr} h=${height} 面积`).toBeLessThanOrEqual(maxDeviceArea)
        expect(w).toBeGreaterThan(0)
        expect(h).toBeGreaterThan(0)
      }
    }
  })

  it('修复前失败的区间现在能出图：49～152 行文字', () => {
    const headerAndFooter = 176 + 116
    const lineHeight = 44
    for (const lines of [49, 80, 120, 152]) {
      const logicalHeight = headerAndFooter + lines * lineHeight
      const { w, h } = canvasOf(logicalHeight, 3)
      expect(w * h).toBeLessThanOrEqual(maxDeviceArea)
      expect(h).toBeLessThanOrEqual(maxDeviceDim)
      // 高度要能装下这些行，说明没有被截断
      expect(Math.min(logicalHeight, maxLogicalHeight)).toBe(logicalHeight)
    }
  })

  it('内容过长时优先降清晰度而不是截断', () => {
    const short = fitScale(1000, 3)
    const long = fitScale(7000, 3)
    expect(long).toBeLessThan(short)
    expect(long).toBeGreaterThanOrEqual(minScale)
  })

  it('异常输入不会算出非法尺寸', () => {
    expect(fitScale(0, 3)).toBeGreaterThan(0)
    expect(fitScale(-100, 3)).toBeGreaterThan(0)
    expect(fitScale(Number.NaN, 3)).toBeGreaterThan(0)
  })
})
