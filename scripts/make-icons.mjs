// Renders the PWA / home-screen icons (a d-pad and the four face buttons) to PNG
// with a few signed-distance shapes, so no image tooling is needed.
import { writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'

const TOP = [0x2c, 0x25, 0x45]
const BOTTOM = [0x13, 0x11, 0x1a]
const DPAD = [0xee, 0xeb, 0xf6]
const FACE = [
  { x: 69, y: 38.5, color: [0x3f, 0x74, 0xe0] }, // X
  { x: 57.5, y: 50, color: [0x2f, 0xae, 0x58] }, // Y
  { x: 80.5, y: 50, color: [0xe5, 0x48, 0x3f] }, // A
  { x: 69, y: 61.5, color: [0xf2, 0xc2, 0x30] }, // B
]

// Signed distances in the 100x100 design grid (negative inside)
const roundBox = (px, py, cx, cy, hw, hh, r) => {
  const qx = Math.abs(px - cx) - hw + r
  const qy = Math.abs(py - cy) - hh + r
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r
}
const circle = (px, py, cx, cy, r) => Math.hypot(px - cx, py - cy) - r

function shade(px, py, rounded) {
  const t = py / 100
  let color = TOP.map((top, i) => top + (BOTTOM[i] - top) * t)
  let alpha = rounded ? (roundBox(px, py, 50, 50, 50, 50, 22) <= 0 ? 1 : 0) : 1
  const dpad = Math.min(roundBox(px, py, 30, 50, 6.5, 17, 2.5), roundBox(px, py, 30, 50, 17, 6.5, 2.5))
  if (dpad <= 0) color = DPAD
  for (const { x, y, color: fill } of FACE) if (circle(px, py, x, y, 7) <= 0) color = fill
  return [...color, alpha * 255]
}

function render(size, rounded) {
  const samples = 4
  const pixels = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sum = [0, 0, 0, 0]
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const rgba = shade(((x + (sx + 0.5) / samples) / size) * 100, ((y + (sy + 0.5) / samples) / size) * 100, rounded)
          // premultiply so transparent corners don't darken the edge
          for (let i = 0; i < 3; i++) sum[i] += (rgba[i] * rgba[3]) / 255
          sum[3] += rgba[3]
        }
      }
      const n = samples * samples
      const alpha = sum[3] / n
      const offset = (y * size + x) * 4
      for (let i = 0; i < 3; i++) pixels[offset + i] = alpha ? Math.round((sum[i] / n) * (255 / alpha)) : 0
      pixels[offset + 3] = Math.round(alpha)
    }
  }
  return encodePng(size, pixels)
}

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (bytes) => {
  let c = 0xffffffff
  for (const b of bytes) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

function encodePng(size, pixels) {
  const stride = size * 4
  const raw = Buffer.alloc((stride + 1) * size)
  for (let y = 0; y < size; y++) pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr.set([8, 6, 0, 0, 0], 8) // 8-bit RGBA
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  return Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))])
}

const icons = [
  ['icon-192.png', 192, true],
  ['icon-512.png', 512, true],
  ['icon-maskable-512.png', 512, false],
  ['apple-touch-icon.png', 180, false],
]
for (const [name, size, rounded] of icons) {
  writeFileSync(new URL(`../public/${name}`, import.meta.url), render(size, rounded))
  console.log(`wrote public/${name}`)
}
