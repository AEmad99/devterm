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
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  readdirSync,
  copyFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const nm = join(root, 'node_modules')

// node-pty-prebuilt-multiarch version (see the `node-pty` alias in package.json).
const NODE_PTY_VER = '0.13.1'

// Derive the Electron module ABI from the installed Electron instead of pinning
// it, so an Electron upgrade doesn't silently keep a wrong-ABI pty.node.
// node-abi ships with electron-builder; fall back to the known table + warning.
const resolveElectronAbi = () => {
  const { version } = JSON.parse(readFileSync(join(nm, 'electron', 'package.json'), 'utf8'))
  try {
    const { getAbi } = require('node-abi')
    return `v${getAbi(version, 'electron')}`
  } catch {
    const known = { 28: 119, 29: 121, 30: 123, 31: 125, 32: 128, 33: 130, 34: 132, 35: 135 }
    const abi = known[Number(version.split('.')[0])]
    if (!abi) {
      throw new Error(`node-abi unavailable and Electron ${version} is not in the fallback ABI table`)
    }
    console.warn(`! node-abi not resolvable; using fallback ABI v${abi} for Electron ${version}`)
    return `v${abi}`
  }
}
const ELECTRON_ABI = resolveElectronAbi()

// SHA-256 integrity pins for the downloaded prebuilt tarballs, keyed by ABI
// (each ABI is a separate upstream artifact). The homebridge releases publish
// no checksums, so these are pinned from a known-good download; extend the map
// when the Electron ABI moves and verify the new hash out-of-band.
const TARBALL_SHA256 = {
  v121: '992c3ce75d41f9ff87dd539ee719ec8ed8c74f51bd0fe0aa6b02394bc636a066'
}

// 1) Electron binary
const electronBin = join(nm, 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
if (existsSync(electronBin)) {
  console.log('✓ Electron binary present')
} else {
  console.log('• Fetching Electron binary…')
  execSync(`node ${JSON.stringify(join(nm, 'electron', 'install.js'))}`, { stdio: 'inherit', cwd: root })
}

// 2) node-pty native addon for the Electron ABI. A marker file records which
//    ABI the installed pty.node was built for; a stale binary from an older
//    Electron (wrong ABI) is re-fetched instead of trusted on sight.
const ptyBin = join(nm, 'node-pty', 'build', 'Release', 'pty.node')
const ptyAbiMarker = join(nm, 'node-pty', 'build', 'Release', '.devterm-abi')
const installedAbi = existsSync(ptyAbiMarker) ? readFileSync(ptyAbiMarker, 'utf8').trim() : null
if (existsSync(ptyBin) && installedAbi === ELECTRON_ABI) {
  console.log(`✓ node-pty native binary present (Electron ABI ${ELECTRON_ABI})`)
} else if (process.platform !== 'win32' || process.arch !== 'x64') {
  if (existsSync(ptyBin)) {
    console.warn(
      `! node-pty binary present but not verified for Electron ABI ${ELECTRON_ABI} (marker: ${installedAbi ?? 'none'}).\n` +
        '  Auto-fetch covers win32-x64 only; if PTYs fail to load, rebuild with `npx electron-rebuild -f -w node-pty`.'
    )
  } else {
    console.warn(
      '! Auto-fetch covers win32-x64 only. On other platforms install VS Build Tools + Python and run\n' +
        '  `npx electron-rebuild -f -w node-pty`, or grab the matching prebuilt from\n' +
        '  https://github.com/homebridge/node-pty-prebuilt-multiarch/releases'
    )
  }
} else {
  if (existsSync(ptyBin)) {
    console.log(`• node-pty binary is stale (ABI ${installedAbi ?? 'unknown'} ≠ ${ELECTRON_ABI}); re-fetching`)
  }
  const url = `https://github.com/homebridge/node-pty-prebuilt-multiarch/releases/download/v${NODE_PTY_VER}/node-pty-prebuilt-multiarch-v${NODE_PTY_VER}-electron-${ELECTRON_ABI}-win32-x64.tar.gz`
  const tgz = join(root, '.node-pty-prebuilt.tar.gz')
  console.log('• Downloading node-pty prebuilt:\n  ' + url)
  const res = await fetch(url)
  if (!res.ok) {
    console.error(`✗ Download failed (HTTP ${res.status}).`)
    process.exit(1)
  }
  const tarball = Buffer.from(await res.arrayBuffer())
  const expectedSha = TARBALL_SHA256[ELECTRON_ABI]
  const actualSha = createHash('sha256').update(tarball).digest('hex')
  if (expectedSha) {
    if (actualSha !== expectedSha) {
      console.error(`✗ SHA-256 mismatch for ${ELECTRON_ABI} tarball:\n  expected ${expectedSha}\n  actual   ${actualSha}`)
      process.exit(1)
    }
  } else {
    console.warn(`! No SHA-256 pin for Electron ABI ${ELECTRON_ABI}; verify ${actualSha} out-of-band and add it to TARBALL_SHA256`)
  }
  writeFileSync(tgz, tarball)
  mkdirSync(join(nm, 'node-pty', 'build'), { recursive: true })
  // Git Bash tar chokes on Windows paths (drive colon = remote host, backslash
  // separators); --force-local + forward slashes keep it happy on every shell.
  const posix = (p) => p.replace(/\\/g, '/')
  execSync(`tar --force-local -xzf ${JSON.stringify(posix(tgz))} -C ${JSON.stringify(posix(join(nm, 'node-pty')))}`, {
    stdio: 'inherit'
  })
  rmSync(tgz)
  writeFileSync(ptyAbiMarker, ELECTRON_ABI + '\n')
  console.log(`✓ node-pty native binary installed (Electron ABI ${ELECTRON_ABI})`)
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

// 4) onnxruntime-web wasm blobs for local (offline, CSP-safe) speech-to-text.
//    Transformers.js defaults to fetching ORT's wasm from a CDN, which the
//    renderer CSP forbids and which breaks offline. Copy the prebuilt wasm/mjs
//    from node_modules into the renderer's public/ort so Vite serves them at
//    /ort/ in dev and bundles them into the packaged app. The STT worker points
//    env.backends.onnx.wasm.wasmPaths at that folder.
{
  const ortDist = join(nm, 'onnxruntime-web', 'dist')
  const ortDest = join(root, 'src', 'renderer', 'public', 'ort')
  const ortFiles = [
    'ort-wasm-simd-threaded.wasm',
    'ort-wasm-simd-threaded.mjs',
    'ort-wasm-simd-threaded.jsep.wasm',
    'ort-wasm-simd-threaded.jsep.mjs'
  ]
  if (!existsSync(ortDist)) {
    console.warn('! onnxruntime-web not found; skipping STT wasm copy (voice dictation will be unavailable)')
  } else {
    mkdirSync(ortDest, { recursive: true })
    let copied = 0
    for (const f of ortFiles) {
      const src = join(ortDist, f)
      if (existsSync(src)) {
        copyFileSync(src, join(ortDest, f))
        copied++
      }
    }
    console.log(`✓ ONNX Runtime wasm copied for STT (${copied}/${ortFiles.length} files)`)
  }
}

console.log('Native setup complete. Next: npm run dev')
