'use strict'

/**
 * Build a multi-size Windows ICO from resources/icon.png using Electron's
 * nativeImage resizer. Run with the bundled Electron binary:
 *   node_modules/electron/dist/electron.exe scripts/write-app-icon.cjs
 */
const { app, nativeImage } = require('electron')
const { writeFileSync } = require('fs')
const { join } = require('path')

const SIZES = [16, 24, 32, 48, 64, 128, 256]

function buildIco(pngBuffers) {
  const count = pngBuffers.length
  const headerSize = 6 + 16 * count
  let offset = headerSize
  const entries = pngBuffers.map((buf, i) => {
    const size = SIZES[i]
    const entry = { width: size >= 256 ? 0 : size, height: size >= 256 ? 0 : size, bytes: buf.length, offset }
    offset += buf.length
  })
  const total = offset
  const out = Buffer.alloc(total)
  out.writeUInt16LE(0, 0)
  out.writeUInt16LE(1, 2)
  out.writeUInt16LE(count, 4)
  let cursor = headerSize
  pngBuffers.forEach((buf, i) => {
    const size = SIZES[i]
    const rec = 6 + 16 * i
    out.writeUInt8(size >= 256 ? 0 : size, rec)
    out.writeUInt8(size >= 256 ? 0 : size, rec + 1)
    out.writeUInt8(0, rec + 2)
    out.writeUInt8(0, rec + 3)
    out.writeUInt16LE(1, rec + 4)
    out.writeUInt16LE(32, rec + 6)
    out.writeUInt32LE(buf.length, rec + 8)
    out.writeUInt32LE(cursor, rec + 12)
    buf.copy(out, cursor)
    cursor += buf.length
  })
  return out
}

app.whenReady().then(() => {
  const pngPath = join(__dirname, '..', 'resources', 'icon.png')
  const src = nativeImage.createFromPath(pngPath)
  if (src.isEmpty()) {
    console.error('icon.png could not be loaded')
    app.exit(1)
    return
  }
  const pngs = SIZES.map((size) => src.resize({ width: size, height: size, quality: 'best' }).toPNG())
  const ico = buildIco(pngs)
  const icoPath = join(__dirname, '..', 'resources', 'icon.ico')
  writeFileSync(icoPath, ico)
  writeFileSync(join(__dirname, '..', 'src', 'renderer', 'public', 'icon.ico'), ico)
  writeFileSync(join(__dirname, '..', 'src', 'renderer', 'public', 'icon.png'), require('fs').readFileSync(pngPath))
  console.log(`wrote ${icoPath} (${ico.length} bytes, ${SIZES.join('/')} px)`)
  app.quit()
})
