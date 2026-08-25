// Decodes the ASCII QR by reconstructing the matrix and trying both polarities.
// It exists so that a QR that cannot be read is never handed over.
import { readFileSync } from 'node:fs'
import jsQR from 'jsqr'

const src = process.argv[2]
const QUIET = 4
const SCALE = 8

const lines = readFileSync(src, 'utf8').split('\n')
const qrLines = lines.filter((l) => /[█▀▄]/.test(l))
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
while (rows.length && rows[rows.length - 1].every((v) => v === 0)) rows.pop()

console.log('matrix: ' + width + ' x ' + rows.length)

function tryDecode(invert, trimTop, trimBottom) {
  const m = rows.slice(trimTop, rows.length - trimBottom)
  const h = m.length
  const w = width
  const W = (w + QUIET * 2) * SCALE
  const H = (h + QUIET * 2) * SCALE
  const data = new Uint8ClampedArray(W * H * 4).fill(255)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const on = invert ? !m[y][x] : !!m[y][x]
      if (!on) continue
      for (let dy = 0; dy < SCALE; dy++) {
        for (let dx = 0; dx < SCALE; dx++) {
          const py = (y + QUIET) * SCALE + dy
          const pxx = (x + QUIET) * SCALE + dx
          const i = (py * W + pxx) * 4
          data[i] = data[i + 1] = data[i + 2] = 0
        }
      }
    }
  }
  const res = jsQR(data, W, H)
  return res ? res.data : null
}

const combos = []
for (const invert of [false, true])
  for (const tt of [0, 1])
    for (const tb of [0, 1, 2]) combos.push([invert, tt, tb])

let found = null
for (const [invert, tt, tb] of combos) {
  const out = tryDecode(invert, tt, tb)
  if (out) {
    found = { invert, tt, tb, out }
    break
  }
}

if (found) {
  console.log('DECODED')
  console.log('  polarity inverted: ' + found.invert)
  console.log('  rows trimmed top/bottom: ' + found.tt + '/' + found.tb)
  console.log('  content: ' + found.out)
} else {
  console.log('NOT decoded with any combination')
  process.exit(1)
}
