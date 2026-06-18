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
import { existsSync, mkdirSync, writeFileSync, rmSync, readdirSync, copyFileSync } from 'node:fs'
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

// 3) Bundled ConPTY dll (Windows only). PtyManager forks with `useConptyDll`
//    to dodge the in-box conhost ConPTY's TUI repaint/teardown bugs. The native
//    conpty.node hard-throws "Cannot find conpty.dll" unless conpty.dll (and the
//    OpenConsole.exe it launches) sit in build/Release/conpty/. The package
//    ships those binaries under third_party/conpty/<version>/win10-<arch>/, but
//    the prebuilt .node tarball doesn't include the folder and the package's own
//    copy step is a postinstall that never runs under `--ignore-scripts`. Lay it
//    down here so it's present in dev and gets asarUnpacked into the build.
if (process.platform === 'win32') {
  const ptyRoot = join(nm, 'node-pty')
  const conptyDest = join(ptyRoot, 'build', 'Release', 'conpty')
  if (existsSync(join(conptyDest, 'conpty.dll'))) {
    console.log('✓ ConPTY bundled dll present')
  } else {
    const tpRoot = join(ptyRoot, 'third_party', 'conpty')
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
    let installed = false
    if (existsSync(tpRoot)) {
      // third_party/conpty/<version>/win10-<arch>/{conpty.dll,OpenConsole.exe}
      for (const ver of readdirSync(tpRoot)) {
        const archDir = join(tpRoot, ver, `win10-${arch}`)
        const srcDll = join(archDir, 'conpty.dll')
        const srcExe = join(archDir, 'OpenConsole.exe')
        if (existsSync(srcDll) && existsSync(srcExe)) {
          mkdirSync(conptyDest, { recursive: true })
          copyFileSync(srcDll, join(conptyDest, 'conpty.dll'))
          copyFileSync(srcExe, join(conptyDest, 'OpenConsole.exe'))
          installed = true
          console.log(`✓ ConPTY bundled dll installed (win10-${arch}, ${ver})`)
          break
        }
      }
    }
    if (!installed) {
      console.warn(
        '! Could not find bundled ConPTY binaries under third_party/conpty.\n' +
          '  PtyManager forks with useConptyDll, so without these the local shell\n' +
          '  fails to spawn. Reinstall node-pty, or copy conpty.dll + OpenConsole.exe\n' +
          '  into node_modules/node-pty/build/Release/conpty/.'
      )
    }
  }
}

console.log('Native setup complete. Next: npm run dev')
