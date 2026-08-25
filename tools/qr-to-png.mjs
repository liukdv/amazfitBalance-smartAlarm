// Converts the ASCII QR printed by `zeus preview` into a crisp, scannable PNG.
//
// The terminal packs two rows of modules into one character:
//   '█' = top and bottom filled · '▀' = top only · '▄' = bottom only · ' ' = none
// From that the exact matrix is reconstructed, without photographing the terminal.
//
// The polarity (whether '█' is a dark or a light module) is NOT guessed: both
// versions are generated and handed to jsQR, keeping the one that decodes.
import { readFileSync, writeFileSync } from 'node:fs'

const src = process.argv[2]
const outPrefix = process.argv[3]
const SCALE = Number(process.argv[4] || 12)
const QUIET = 4

const lines = readFileSync(src, 'utf8').split('\n')
const qrLines = lines.filter((l) => /[█▀▄]/.test(l))
if (!qrLines.length) {
  console.error('no QR found in ' + src)
  process.exit(1)
}

const width = Math.max(...qrLines.map((l) => [...l].length))
const rows = []
for (const line of qrLines) {
  const chars = [...line]
  const top = []
  const bot = []
  for (let x = 0; x < width; x++) {
    const c = chars[x] === undefined ? ' ' : chars[x]
    top.push(c === '█' || c === '▀' ? 1 : 0)
    bot.push(c === '█' || c === '▄' ? 1 : 0)
  }
  rows.push(top, bot)
}

// Some trailing rows can be half empty: drop the all-zero rows at the end.
while (rows.length && rows[rows.length - 1].every((v) => v === 0)) rows.pop()

console.log('matrix reconstructed: ' + width + ' x ' + rows.length)

function render(matrix, invert) {
  const h = matrix.length
  const w = width
  const W = (w + QUIET * 2) * SCALE
  const H = (h + QUIET * 2) * SCALE
  const px = Buffer.alloc(W * H, 255)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const on = invert ? !matrix[y][x] : !!matrix[y][x]
      if (!on) continue
      for (let dy = 0; dy < SCALE; dy++) {
        const row = (y + QUIET) * SCALE + dy
        const start = row * W + (x + QUIET) * SCALE
        px.fill(0, start, start + SCALE)
      }
    }
  }
  return { px, W, H }
}

// 8-bit grayscale PNG written by hand: no external dependency.
import { deflateSync } from 'node:zlib'
function png({ px, W, H }) {
  const raw = Buffer.alloc((W + 1) * H)
  for (let y = 0; y < H; y++) {
    raw[y * (W + 1)] = 0
    px.copy(raw, y * (W + 1) + 1, y * W, (y + 1) * W)
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(td) >>> 0)
    return Buffer.concat([len, td, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(W, 0)
  ihdr.writeUInt32BE(H, 4)
  ihdr[8] = 8
  ihdr[9] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

let T = null
function crc32(buf) {
  if (!T) {
    T = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      T[n] = c
    }
  }
  let c = -1
  for (let i = 0; i < buf.length; i++) c = T[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return c ^ -1
}

for (const [name, invert] of [
  ['a', false],
  ['b', true],
]) {
  const img = render(rows, invert)
  writeFileSync(outPrefix + '-' + name + '.png', png(img))
  console.log('written ' + outPrefix + '-' + name + '.png (' + img.W + 'x' + img.H + ')')
}
