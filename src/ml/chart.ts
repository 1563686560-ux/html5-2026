/** 用 Canvas 2D 画预测折线图，随主题取色，支持高 DPI */

function cssVar(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value || fallback
}

export function drawForecastChart(
  canvas: HTMLCanvasElement,
  actual: number[],
  forecast: number[],
  fitted: number[],
  size?: { width?: number; height?: number; pixelRatio?: number; forecastLabel?: string }
): void {
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  const dpr = Math.min(size?.pixelRatio ?? (window.devicePixelRatio || 1), 3)
  const width = size?.width ?? (canvas.clientWidth || 320)
  const height = size?.height ?? (canvas.clientHeight || 220)
  canvas.width = Math.round(width * dpr)
  canvas.height = Math.round(height * dpr)
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, width, height)

  const padL = 52
  const padR = 14
  const padT = 14
  const padB = 26
  const plotW = width - padL - padR
  const plotH = height - padT - padB

  const all = [...actual, ...forecast, ...fitted]
  if (!actual.length || all.some((value) => !Number.isFinite(value))) return
  const low = Math.min(...all)
  const high = Math.max(...all)
  const padding =
    high === low ? (low === 0 ? 0.5 : Math.max(Math.abs(low) * 0.05, Number.MIN_VALUE)) : (high - low) * 0.05
  const min = low - padding
  const max = high + padding
  const span = max - min
  const total = actual.length + forecast.length
  const xFor = (i: number): number => padL + (total <= 1 ? 0 : (i / (total - 1)) * plotW)
  const yFor = (v: number): number => padT + (1 - (v - min) / span) * plotH

  const grid = cssVar('--border', '#e5e7eb')
  const text = cssVar('--text-3', '#9ca3af')
  const actualColor = cssVar('--chart-history', '#5264d9')
  const fittedColor = cssVar('--chart-fitted', '#936014')
  const forecastColor = cssVar('--chart-forecast', '#8165d2')

  ctx.font = '11px system-ui, sans-serif'
  ctx.lineWidth = 1

  // 网格与 Y 轴刻度
  const ticks = 4
  for (let i = 0; i <= ticks; i++) {
    const value = min + (span * i) / ticks
    const y = yFor(value)
    ctx.strokeStyle = grid
    ctx.beginPath()
    ctx.moveTo(padL, y)
    ctx.lineTo(width - padR, y)
    ctx.stroke()
    ctx.fillStyle = text
    ctx.textAlign = 'right'
    ctx.textBaseline = 'middle'
    ctx.fillText(formatTick(value), padL - 6, y)
  }

  const drawLine = (values: number[], offset: number, color: string, dash: number[] = []): void => {
    ctx.strokeStyle = color
    ctx.setLineDash(dash)
    ctx.beginPath()
    values.forEach((value, index) => {
      const x = xFor(index + offset)
      const y = yFor(value)
      if (index === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    })
    ctx.stroke()
    ctx.setLineDash([])
  }

  // 拟合线（训练段，虚线弱化）
  if (fitted.length > 0) drawLine(fitted, Math.max(0, actual.length - fitted.length), fittedColor, [4, 4])
  // 实际数据
  drawLine(actual, 0, actualColor)
  // 预测外推（从最后一个实际点接续）
  const forecastStart = actual.length - 1
  drawLine([actual[actual.length - 1], ...forecast], forecastStart, forecastColor, [6, 4])

  // 预测段的分界点
  ctx.fillStyle = forecastColor
  ctx.beginPath()
  ctx.arc(xFor(forecastStart), yFor(actual[actual.length - 1]), 3, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = text
  ctx.textBaseline = 'bottom'
  ctx.textAlign = 'left'
  ctx.fillText('历史序号', padL, height - 2)
  ctx.textAlign = 'right'
  ctx.fillText(size?.forecastLabel ?? `未来 ${forecast.length} 步`, width - padR, height - 2)
}

function formatTick(value: number): string {
  const abs = Math.abs(value)
  if (abs >= 1e6 || (abs > 0 && abs < 0.01)) return value.toExponential(1)
  if (abs >= 1000) return `${(value / 1000).toFixed(1)}k`
  if (abs >= 100) return value.toFixed(0)
  if (abs >= 1) return value.toFixed(1)
  return value.toFixed(2)
}
