// One-shot native setup for `npm install --ignore-scripts` clones.
//
// Two things a plain install can't reliably do here:
//   1. Fetch Electron's own binary (skipped by --ignore-scripts).
//   2. Fetch a `node-pty` native addon matching ELECTRON's ABI (not Node's) —
//      this box has no C++ toolchain, so we pull a prebuilt binary instead of
//      compiling. The npm tarball ships Linux prebuilds only; the Windows binary
//      lives in the @homebridge/node-pty-prebuilt-multiarch GitHub release.
//
// Run with: npm run setup   (after `npm install --ignore-scripts`)

import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const nm = join(root, 'node_modules')

// node-pty-prebuilt-multiarch version (see the `node-pty` alias in package.json)
// and the Electron module ABI we pin to (Electron 29 → v121).
const NODE_PTY_VER = '0.13.1'
const ELECTRON_ABI = 'v121'

// 1) Electron binary
const electronBin = join(nm, 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
if (existsSync(electronBin)) {
  console.log('✓ Electron binary present')
} else {
  console.log('• Fetching Electron binary…')
  execSync(`node ${JSON.stringify(join(nm, 'electron', 'install.js'))}`, { stdio: 'inherit', cwd: root })
}

// 2) node-pty native addon for the Electron ABI
const ptyBin = join(nm, 'node-pty', 'build', 'Release', 'pty.node')
if (existsSync(ptyBin)) {
  console.log('✓ node-pty native binary present')
} else if (process.platform !== 'win32' || process.arch !== 'x64') {
  console.warn(
    '! Auto-fetch covers win32-x64 only. On other platforms install VS Build Tools + Python and run\n' +
      '  `npx electron-rebuild -f -w node-pty`, or grab the matching prebuilt from\n' +
      '  https://github.com/homebridge/node-pty-prebuilt-multiarch/releases'
  )
} else {
  const url = `https://github.com/homebridge/node-pty-prebuilt-multiarch/releases/download/v${NODE_PTY_VER}/node-pty-prebuilt-multiarch-v${NODE_PTY_VER}-electron-${ELECTRON_ABI}-win32-x64.tar.gz`
  const tgz = join(root, '.node-pty-prebuilt.tar.gz')
  console.log('• Downloading node-pty prebuilt:\n  ' + url)
  const res = await fetch(url)
  if (!res.ok) {
    console.error(`✗ Download failed (HTTP ${res.status}).`)
    process.exit(1)
  }
  writeFileSync(tgz, Buffer.from(await res.arrayBuffer()))
  mkdirSync(join(nm, 'node-pty', 'build'), { recursive: true })
  execSync(`tar -xzf ${JSON.stringify(tgz)} -C ${JSON.stringify(join(nm, 'node-pty'))}`, { stdio: 'inherit' })
  rmSync(tgz)
  console.log('✓ node-pty native binary installed')
}

console.log('Native setup complete. Next: npm run dev')
