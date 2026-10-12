import { afterEach, expect, it, vi } from 'vitest'
import { drawForecastChart } from './chart'
afterEach(() => vi.unstubAllGlobals())
function setup() {
  vi.stubGlobal('window', { devicePixelRatio: 1 })
  vi.stubGlobal('document', { documentElement: {} })
  vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: (name: string) => name }))
  const paths: Array<{ color: string; first: number[]; points: number[][] }> = []
  let points: number[][] = []
  const ctx = {
    strokeStyle: '',
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    fillText: vi.fn(),
    setLineDash: vi.fn(),
    beginPath: () => {
      points = []
    },
    moveTo: (x: number, y: number) => {
      points.push([x, y])
    },
    lineTo: (x: number, y: number) => {
      points.push([x, y])
    },
    stroke: () => {
      paths.push({ color: ctx.strokeStyle, first: points[0], points: [...points] })
    },
    arc: vi.fn(),
    fill: vi.fn()
  }
  const canvas = { clientWidth: 320, clientHeight: 220, getContext: () => ctx } as unknown as HTMLCanvasElement
  return { canvas, ctx, paths }
}
it('拟合的第一个值放在正确的历史时点，而非从序列起点画起', () => {
  const { canvas, paths } = setup()
  drawForecastChart(canvas, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], [11], [8, 9, 10])
  const fitted = paths.find((path) => path.color === '--chart-fitted')!
  const history = paths.find((path) => path.color === '--chart-history')!
  expect(fitted.first[0]).toBeCloseTo(history.points[7][0])
})
it('拟合超出历史范围或恒定序列，线条仍在绘图区内且坐标有限', () => {
  const { canvas, paths } = setup()
  drawForecastChart(canvas, [1, 2, 3, 4, 5], [6], [30, 40])
  for (const path of paths)
    for (const [, y] of path.points) {
      expect(y).toBeGreaterThanOrEqual(14)
      expect(y).toBeLessThanOrEqual(194)
    }
  paths.length = 0
  drawForecastChart(canvas, [0, 0, 0, 0, 0], [0, 0], [0, 0])
  for (const path of paths)
    for (const [x, y] of path.points) {
      expect(Number.isFinite(x)).toBe(true)
      expect(Number.isFinite(y)).toBe(true)
    }
})
