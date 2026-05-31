// Generates the DevTerm app icon (a terminal-prompt ">_" mark) as a
// multi-resolution .ico plus a .png and an .svg source — all in pure Node
// (zlib only), so it builds on a box without native image tooling.
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'resources')
mkdirSync(OUT, { recursive: true })

// --- palette (matches the app theme) ---------------------------------------
const TOP = [30, 38, 54] // #1e2636 — tile gradient top
const BOTTOM = [16, 18, 24] // #101218 — tile gradient bottom
const ACCENT = [76, 139, 245] // #4c8bf5 — chevron (app accent)
const ACCENT_HI = [124, 170, 255] // edge rim glow
const CURSOR = [78, 201, 176] // #4ec9b0 — cursor block (app "local" color)

const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t)

// --- signed-distance fields (normalized 0..1 space) ------------------------
function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - hw + r
  const qy = Math.abs(py - cy) - hh + r
  const ox = Math.max(qx, 0)
  const oy = Math.max(qy, 0)
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r
}
function sdCapsule(px, py, ax, ay, bx, by, r) {
  const pax = px - ax
  const pay = py - ay
  const bax = bx - ax
  const bay = by - ay
  const h = Math.max(0, Math.min(1, (pax * bax + pay * bay) / (bax * bax + bay * bay)))
  return Math.hypot(pax - bax * h, pay - bay * h) - r
}

// Returns [r,g,b,a] (a in 0..1) for a point in normalized icon space.
function shade(fx, fy) {
  const tile = sdRoundRect(fx, fy, 0.5, 0.5, 0.5, 0.5, 0.22)
  if (tile >= 0) return [0, 0, 0, 0] // outside the rounded tile → transparent
  let base = mix(TOP, BOTTOM, fy)
  if (tile > -0.02) base = mix(base, ACCENT_HI, 0.35) // subtle inner rim
  // ">" chevron
  const r = 0.058
  const seg1 = sdCapsule(fx, fy, 0.31, 0.29, 0.56, 0.5, r)
  const seg2 = sdCapsule(fx, fy, 0.56, 0.5, 0.31, 0.71, r)
  const chevron = Math.min(seg1, seg2)
  // "_" cursor block
  const cursor = sdRoundRect(fx, fy, 0.71, 0.69, 0.115, 0.05, 0.035)
  if (cursor < 0) return [...CURSOR, 1]
  if (chevron < 0) return [...ACCENT, 1]
  return [...base, 1]
}

// --- render with 4x4 supersampling (premultiplied for clean alpha edges) ---
function renderRGBA(size) {
  const SS = 4
  const buf = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let sa = 0
      let sr = 0
      let sg = 0
      let sb = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const fx = (x + (sx + 0.5) / SS) / size
          const fy = (y + (sy + 0.5) / SS) / size
          const [r, g, b, a] = shade(fx, fy)
          sa += a
          sr += r * a
          sg += g * a
          sb += b * a
        }
      }
      const n = SS * SS
      const a = sa / n
      const o = (y * size + x) * 4
      buf[o] = sa > 0 ? Math.round(sr / sa) : 0
      buf[o + 1] = sa > 0 ? Math.round(sg / sa) : 0
      buf[o + 2] = sa > 0 ? Math.round(sb / sa) : 0
      buf[o + 3] = Math.round(a * 255)
    }
  }
  return buf
}

// --- minimal PNG encoder ----------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
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
function encodePNG(rgba, size) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  // rows prefixed with filter byte 0
  const raw = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

// --- ICO assembler (PNG-compressed entries) --------------------------------
function encodeICO(entries) {
  const dir = Buffer.alloc(6)
  dir.writeUInt16LE(0, 0)
  dir.writeUInt16LE(1, 2) // type: icon
  dir.writeUInt16LE(entries.length, 4)
  let offset = 6 + entries.length * 16
  const dirEntries = []
  for (const { size, png } of entries) {
    const e = Buffer.alloc(16)
    e[0] = size >= 256 ? 0 : size
    e[1] = size >= 256 ? 0 : size
    e[2] = 0 // palette
    e[3] = 0
    e.writeUInt16LE(1, 4) // planes
    e.writeUInt16LE(32, 6) // bpp
    e.writeUInt32LE(png.length, 8)
    e.writeUInt32LE(offset, 12)
    offset += png.length
    dirEntries.push(e)
  }
  return Buffer.concat([dir, ...dirEntries, ...entries.map((e) => e.png)])
}

// --- editable SVG source (mirrors the SDF geometry) ------------------------
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#1e2636"/>
      <stop offset="1" stop-color="#101218"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="1024" height="1024" rx="225" fill="url(#bg)"/>
  <rect x="3" y="3" width="1018" height="1018" rx="223" fill="none" stroke="#7caaff" stroke-opacity="0.28" stroke-width="6"/>
  <g fill="none" stroke="#4c8bf5" stroke-width="119" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="317,297 573,512 317,727"/>
  </g>
  <rect x="610" y="654" width="236" height="102" rx="36" fill="#4ec9b0"/>
</svg>
`

// --- write everything -------------------------------------------------------
const icoSizes = [16, 24, 32, 48, 64, 128, 256]
const entries = icoSizes.map((size) => ({ size, png: encodePNG(renderRGBA(size), size) }))
writeFileSync(join(OUT, 'icon.ico'), encodeICO(entries))
writeFileSync(join(OUT, 'icon.png'), encodePNG(renderRGBA(512), 512))
writeFileSync(join(OUT, 'icon.svg'), SVG)
console.log('Wrote resources/icon.ico (' + icoSizes.join(',') + '), icon.png (512), icon.svg')
