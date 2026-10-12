// 生成 PWA 图标（192 / 512 / 180），纯 Node 手写 PNG 编码，无外部依赖。
// 运行：node scripts/generate-icons.mjs
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const outDir = resolve(__dirname, '../public/icons')
mkdirSync(outDir, { recursive: true })

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crc])
}

function encodePNG(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type: RGBA
  ihdr[10] = 0 // compression
  ihdr[11] = 0 // filter
  ihdr[12] = 0 // interlace
  const stride = width * 4 + 1
  const raw = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0 // filter: none
    rgba.copy(raw, y * stride + 1, y * width * 4, (y + 1) * width * 4)
  }
  const idat = deflateSync(raw, { level: 9 })
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))])
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const lerp = (a, b, t) => a + (b - a) * t

function hexToRgb(hex) {
  const value = parseInt(hex.slice(1), 16)
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]
}

function setPixel(buf, size, x, y, r, g, b, a) {
  const i = (y * size + x) * 4
  buf[i] = r
  buf[i + 1] = g
  buf[i + 2] = b
  buf[i + 3] = a
}

function drawIcon(size) {
  const buf = Buffer.alloc(size * size * 4)
  const top = hexToRgb('#5b7cfa')
  const bottom = hexToRgb('#7c5bff')
  const half = size / 2
  const corner = size * 0.22

  // 圆角方形渐变背景
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5
      const py = y + 0.5
      const dx = Math.abs(px - half) - (half - corner)
      const dy = Math.abs(py - half) - (half - corner)
      const ox = Math.max(dx, 0)
      const oy = Math.max(dy, 0)
      const dist = Math.min(Math.max(dx, dy), 0) + Math.hypot(ox, oy) - corner
      const alpha = clamp(0.5 - dist, 0, 1)
      if (alpha <= 0) continue
      const t = y / size
      setPixel(
        buf,
        size,
        x,
        y,
        Math.round(lerp(top[0], bottom[0], t)),
        Math.round(lerp(top[1], bottom[1], t)),
        Math.round(lerp(top[2], bottom[2], t)),
        Math.round(alpha * 255)
      )
    }
  }

  // 白色圆环（"洞察之眼"）
  const cx = size / 2
  const cy = size / 2
  const outer = size * 0.2
  const inner = size * 0.115
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy)
      const ring = clamp(Math.min(d - inner, outer - d) + 0.5, 0, 1)
      if (ring > 0) setPixel(buf, size, x, y, 255, 255, 255, Math.round(ring * 255))
    }
  }

  // 中心焦点
  const dot = size * 0.045
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy)
      const a = clamp(dot - d + 0.5, 0, 1)
      if (a > 0) setPixel(buf, size, x, y, 255, 255, 255, Math.round(a * 255))
    }
  }

  return buf
}

for (const size of [192, 512, 180]) {
  const png = encodePNG(size, size, drawIcon(size))
  const file = resolve(outDir, `icon-${size}.png`)
  writeFileSync(file, png)
  console.log(`generated ${file} (${png.length} bytes)`)
}
