/**
 * 会话导出为长图
 * ------------------------------------------------------------------
 * 用 Canvas 2D 把整段对话画成一张可以直接发出去的长图。
 *
 * 为什么不用 html2canvas 之类的库？
 *   1. 那些库本质也是把 DOM 转成 canvas 指令，遇到 v-html 里的复杂样式
 *      经常还原不准；
 *   2. 自己画可以完全掌控排版：字体、行高、气泡圆角、渐变、留白，
 *      导出结果比截图更"像个作品"；
 *   3. 顺带展示了 Canvas 文本度量与换行算法 —— 这是实打实的前端功夫。
 *
 * 两个必须处理的工程细节：
 *   - 中文没有空格，不能按空格断行，必须逐字度量宽度来折行；
 *   - 高分屏要按 devicePixelRatio 放大画布再缩放上下文，否则导出的字发虚。
 */

import { markdownToPlainText } from './markdown'

export interface ExportMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface ExportPayload {
  /** 会话标题 */
  title: string
  personaName: string
  personaAvatar: string
  messages: ExportMessage[]
}

/* ---- 版面常量（逻辑像素，最后统一乘缩放系数） ---- */
const WIDTH = 750
const PAD = 42
const FONT_SIZE = 28
const LINE_HEIGHT = 44
const BUBBLE_PAD_X = 26
const BUBBLE_PAD_Y = 22
const GAP = 26
const MAX_BUBBLE_W = 520
const HEADER_H = 176
const FOOTER_H = 116

/**
 * 画布尺寸限制（单位：**设备像素**，不是逻辑像素）
 * ------------------------------------------------------------------
 * 这里曾经有个隐蔽的错：判断上限时用的是逻辑像素，但画布实际尺寸是
 * 逻辑像素 × scale。于是 iPhone（dpr=3）上 7000 的逻辑高度会真的开出
 * 2250 × 21000 的画布 —— 超出 Safari 的边长上限，也远超 1677 万像素的
 * 面积上限，结果就是一张**全白图**或者直接失败。
 *
 * 正确做法有两步：
 *   1. 逻辑高度本身设一个「再长也没法看」的上限；
 *   2. 缩放系数按真实设备像素反算，内容长就自动降清晰度，而不是截断。
 */
const MAX_LOGICAL_H = 7000
/** 单边上限：Chrome / Safari 都在 16384 附近截断，超了给空白图 */
const MAX_DEVICE_DIM = 16_384
/** 面积上限：iOS Safari 约 1677 万像素（4096 × 4096） */
const MAX_DEVICE_AREA = 16_777_216
/** 缩放系数的下限：再低文字就没法看了，宁可截断 */
const MIN_SCALE = 1

/** 对外暴露尺寸常量，便于测试断言「不超限」 */
export const CANVAS_LIMITS = {
  width: WIDTH,
  maxLogicalHeight: MAX_LOGICAL_H,
  maxDeviceDim: MAX_DEVICE_DIM,
  maxDeviceArea: MAX_DEVICE_AREA,
  minScale: MIN_SCALE
} as const

const COLOR = {
  bgTop: '#0e1020',
  bgBottom: '#151a2e',
  headerText: '#f2f4fb',
  muted: '#8b93ab',
  bubbleAssistant: '#1d2238',
  bubbleBorder: '#2c3350',
  textAssistant: '#e9edf9',
  textUser: '#ffffff',
  brandFrom: '#6d8bff',
  brandTo: '#a97bff'
} as const

/* ------------------------------------------------------------------ */
/* 文本处理                                                            */
/* ------------------------------------------------------------------ */

/**
 * 分词。
 * 中文一个字就是一个断点，拉丁字母/数字要连成整词再断，
 * 否则 "JavaScript" 会被从中间劈开。
 */
function tokenize(text: string): string[] {
  const tokens: string[] = []
  let buffer = ''

  for (const char of text) {
    // 用 for...of 迭代的是码点，emoji 不会被拆成两半
    if (/[A-Za-z0-9@._/:'"+-]/.test(char)) {
      buffer += char
      continue
    }
    if (buffer) {
      tokens.push(buffer)
      buffer = ''
    }
    tokens.push(char)
  }
  if (buffer) tokens.push(buffer)
  return tokens
}

/** 按最大宽度折行；保留原有的换行符 */
function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = []

  for (const paragraph of text.split('\n')) {
    if (!paragraph.trim()) {
      lines.push('')
      continue
    }

    let line = ''
    for (const token of tokenize(paragraph)) {
      const candidate = line + token
      if (line && ctx.measureText(candidate).width > maxWidth) {
        lines.push(line.trimEnd())
        // 行首不留空格，避免出现莫名的缩进
        line = token === ' ' ? '' : token
      } else {
        line = candidate
      }
    }
    lines.push(line.trimEnd())
  }

  return lines
}

/* ------------------------------------------------------------------ */
/* 绘制辅助                                                            */
/* ------------------------------------------------------------------ */

/** 手写圆角矩形路径：ctx.roundRect 在旧版 Safari 上不存在 */
function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const radius = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.arcTo(x + w, y, x + w, y + h, radius)
  ctx.arcTo(x + w, y + h, x, y + h, radius)
  ctx.arcTo(x, y + h, x, y, radius)
  ctx.arcTo(x, y, x + w, y, radius)
  ctx.closePath()
}

interface Block {
  role: 'user' | 'assistant'
  lines: string[]
  width: number
  height: number
  /** 气泡左上角坐标 */
  x: number
  y: number
}

/**
 * 先排版再绘制。
 * 分两步是因为画布高度必须在创建时就确定，而高度取决于全部文本折行结果。
 */
function layout(
  ctx: CanvasRenderingContext2D,
  messages: ExportMessage[],
  maxHeight: number
): {
  blocks: Block[]
  height: number
  truncated: boolean
} {
  const contentMaxW = MAX_BUBBLE_W - BUBBLE_PAD_X * 2
  const blocks: Block[] = []
  let y = HEADER_H
  let truncated = false

  for (const message of messages) {
    const plain = message.role === 'user' ? message.content : markdownToPlainText(message.content)
    if (!plain.trim()) continue

    ctx.font = `${FONT_SIZE}px "PingFang SC", "Microsoft YaHei", system-ui, sans-serif`
    const lines = wrapText(ctx, plain, contentMaxW)

    // 取最长一行的实际宽度，让短消息的气泡贴合内容而不是一律拉满
    let width = 0
    for (const line of lines) {
      width = Math.max(width, ctx.measureText(line).width)
    }
    width = Math.min(width + BUBBLE_PAD_X * 2, MAX_BUBBLE_W)
    const height = lines.length * LINE_HEIGHT + BUBBLE_PAD_Y * 2

    if (y + height + FOOTER_H > maxHeight) {
      truncated = true
      break
    }

    const x = message.role === 'user' ? WIDTH - PAD - width : PAD + 56 // 给助手头像让出位置

    blocks.push({ role: message.role, lines, width, height, x, y })
    y += height + GAP
  }

  return { blocks, height: y + FOOTER_H, truncated }
}

/* ------------------------------------------------------------------ */
/* 主绘制                                                              */
/* ------------------------------------------------------------------ */

/**
 * 按设备像素限制反算缩放系数。
 * 内容越长，缩放系数自动越小 —— 用一点清晰度换完整性，
 * 总好过开出一张超过浏览器上限的空白图。
 * 返回值同时受「期望清晰度」上限约束，不会超过 pickScale() 的结果。
 */
export function fitScale(logicalHeight: number, preferred: number): number {
  const height = Number.isFinite(logicalHeight) ? Math.min(Math.max(logicalHeight, 1), MAX_LOGICAL_H) : 1
  const want = Number.isFinite(preferred) ? preferred : MIN_SCALE
  const byDim = Math.min(MAX_DEVICE_DIM / WIDTH, MAX_DEVICE_DIM / height)
  const byArea = Math.sqrt(MAX_DEVICE_AREA / (WIDTH * height))
  const scale = Math.min(want, byDim, byArea)
  return Math.max(MIN_SCALE, Math.floor(scale * 100) / 100)
}

export interface CanvasSize {
  /** 画布宽（设备像素） */
  width: number
  /** 画布高（设备像素） */
  height: number
  scale: number
  /** 实际使用的逻辑高度（已被上限截断） */
  logicalHeight: number
}

/**
 * 由内容高度算出真实画布尺寸。
 * 尺寸一律**向下取整**：向上取整会让宽高各多出不到 1 像素，
 * 累乘之后就可能刚好顶破面积上限（实测会超出约 2000 像素）。
 */
export function canvasSize(logicalHeight: number, preferredScale: number): CanvasSize {
  const height = Number.isFinite(logicalHeight)
    ? Math.min(Math.max(logicalHeight, 1), MAX_LOGICAL_H)
    : 1
  const scale = fitScale(height, preferredScale)
  return {
    width: Math.floor(WIDTH * scale),
    height: Math.floor(height * scale),
    scale,
    logicalHeight: height
  }
}

function draw(payload: ExportPayload, preferredScale: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  const probe = canvas.getContext('2d')
  if (!probe) throw new Error('当前浏览器不支持 Canvas 2D')

  // 先用逻辑像素排一遍版：折行只和逻辑宽度有关，与缩放系数无关，
  // 拿到真实高度后才能算出既清晰又不超限的缩放系数。
  const { blocks, height, truncated } = layout(probe, payload.messages, MAX_LOGICAL_H)
  const plan = canvasSize(height, preferredScale)
  const totalH = plan.logicalHeight

  canvas.width = plan.width
  canvas.height = plan.height
  if (canvas.width <= 0 || canvas.height <= 0) throw new Error('画布尺寸异常，无法生成图片')

  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('当前浏览器不支持 Canvas 2D')
  ctx.scale(plan.scale, plan.scale)

  // 背景
  const bg = ctx.createLinearGradient(0, 0, WIDTH * 0.4, totalH)
  bg.addColorStop(0, COLOR.bgTop)
  bg.addColorStop(1, COLOR.bgBottom)
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, WIDTH, totalH)

  // ---- 页头 ----
  ctx.font = '600 40px "PingFang SC", "Microsoft YaHei", system-ui, sans-serif'
  ctx.fillStyle = COLOR.headerText
  ctx.textBaseline = 'middle'
  ctx.fillText(`${payload.personaAvatar} ${payload.personaName}`, PAD, 62)

  ctx.font = '26px "PingFang SC", "Microsoft YaHei", system-ui, sans-serif'
  ctx.fillStyle = COLOR.muted
  const subtitle = payload.title.length > 22 ? `${payload.title.slice(0, 22)}…` : payload.title
  ctx.fillText(subtitle, PAD, 108)

  ctx.font = '24px "PingFang SC", "Microsoft YaHei", system-ui, sans-serif'
  ctx.fillText(formatDate(new Date()), PAD, 146)

  // 页头下的分隔线
  ctx.strokeStyle = COLOR.bubbleBorder
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(PAD, HEADER_H - 18)
  ctx.lineTo(WIDTH - PAD, HEADER_H - 18)
  ctx.stroke()

  // ---- 消息气泡 ----
  for (const block of blocks) {
    const isUser = block.role === 'user'

    // 助手头像
    if (!isUser) {
      ctx.beginPath()
      ctx.arc(PAD + 18, block.y + 20, 18, 0, Math.PI * 2)
      ctx.fillStyle = COLOR.bubbleAssistant
      ctx.fill()
      ctx.font = '18px system-ui'
      ctx.textAlign = 'center'
      ctx.fillStyle = COLOR.textAssistant
      ctx.fillText(payload.personaAvatar, PAD + 18, block.y + 21)
      ctx.textAlign = 'left'
    }

    roundRect(ctx, block.x, block.y, block.width, block.height, 22)

    if (isUser) {
      const grad = ctx.createLinearGradient(block.x, block.y, block.x + block.width, block.y + block.height)
      grad.addColorStop(0, COLOR.brandFrom)
      grad.addColorStop(1, COLOR.brandTo)
      ctx.fillStyle = grad
      ctx.fill()
    } else {
      ctx.fillStyle = COLOR.bubbleAssistant
      ctx.fill()
      ctx.strokeStyle = COLOR.bubbleBorder
      ctx.lineWidth = 1
      ctx.stroke()
    }

    ctx.font = `${FONT_SIZE}px "PingFang SC", "Microsoft YaHei", system-ui, sans-serif`
    ctx.fillStyle = isUser ? COLOR.textUser : COLOR.textAssistant
    ctx.textBaseline = 'middle'
    block.lines.forEach((line, i) => {
      ctx.fillText(line, block.x + BUBBLE_PAD_X, block.y + BUBBLE_PAD_Y + i * LINE_HEIGHT + LINE_HEIGHT / 2)
    })
  }

  // ---- 页脚 ----
  const footerY = totalH - 62
  ctx.strokeStyle = COLOR.bubbleBorder
  ctx.beginPath()
  ctx.moveTo(PAD, footerY - 30)
  ctx.lineTo(WIDTH - PAD, footerY - 30)
  ctx.stroke()

  ctx.font = '24px "PingFang SC", "Microsoft YaHei", system-ui, sans-serif'
  ctx.fillStyle = COLOR.muted
  ctx.textBaseline = 'middle'
  ctx.fillText(truncated ? '内容过长，已截断 · AI 智囊团' : '由 AI 智囊团生成', PAD, footerY)

  ctx.textAlign = 'right'
  ctx.fillText('AI 智囊团', WIDTH - PAD, footerY)
  ctx.textAlign = 'left'

  return canvas
}

function formatDate(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/* ------------------------------------------------------------------ */
/* 对外接口                                                            */
/* ------------------------------------------------------------------ */

function toBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new Error('图片生成失败'))
    }, 'image/png')
  })
}

/** 期望的缩放系数：至少 2 倍保证高分屏清晰，最高 3 倍避免画布过大。
 *  实际使用值会再经过 fitScale()，内容超长时自动下调。 */
function pickScale(): number {
  const dpr = window.devicePixelRatio || 1
  return Math.min(Math.max(dpr, 2), 3)
}

function buildFilename(personaName: string): string {
  const now = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
  return `AI智囊团-${personaName}-${stamp}.png`
}

/** 直接下载到本地 */
export async function downloadConversationImage(payload: ExportPayload): Promise<string> {
  const canvas = draw(payload, pickScale())
  const blob = await toBlob(canvas)
  const filename = buildFilename(payload.personaName)

  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  // 立刻 revoke 会让部分浏览器来不及取数据，延后释放
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000)

  return filename
}

export type ShareOutcome = 'shared' | 'downloaded' | 'cancelled'

/**
 * 优先调用系统分享（手机上可以直接发到微信/相册），
 * 不支持时退回到下载。用户取消分享不算失败，单独返回 'cancelled'。
 */
export async function shareConversationImage(payload: ExportPayload): Promise<ShareOutcome> {
  const canvas = draw(payload, pickScale())
  const blob = await toBlob(canvas)
  const filename = buildFilename(payload.personaName)

  const file = new File([blob], filename, { type: 'image/png' })

  if (navigator.canShare?.({ files: [file] }) && navigator.share) {
    try {
      await navigator.share({ files: [file], title: `${payload.personaName} · 对话记录` })
      return 'shared'
    } catch (error) {
      // AbortError 表示用户自己取消了，不该报错
      if (error instanceof DOMException && error.name === 'AbortError') return 'cancelled'
      // 其他错误继续走下载兜底
    }
  }

  await downloadConversationImage(payload)
  return 'downloaded'
}
