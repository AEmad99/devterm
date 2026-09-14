'use strict'

/**
 * Packaging helpers for node-pty's Windows native addons.
 *
 * `@homebridge/node-pty-prebuilt-multiarch` does not list `build/` in its npm
 * `files` field (Windows ConPTY addons are downloaded by `npm run setup` into
 * `build/Release/`). electron-builder honors that field when collecting
 * production deps, so a packaged app can ship node-pty's JS and still throw
 * `Cannot find module '../build/Release/conpty.node'` on every local PTY —
 * including every agent. beforePack patches `files` so the natives are copied;
 * afterPack refuses to ship a Windows build that is missing them.
 */

const fs = require('fs')
const path = require('path')

const WIN_PTY_RELEASE_FILES = [
  'conpty.node',
  'pty.node',
  'conpty_console_list.node',
  'winpty.dll',
  'winpty-agent.exe'
]

function releaseDirFromProject(projectDir) {
  return path.join(projectDir, 'node_modules', 'node-pty', 'build', 'Release')
}

function releaseDirFromApp(appOutDir) {
  return path.join(
    appOutDir,
    'resources',
    'app.asar.unpacked',
    'node_modules',
    'node-pty',
    'build',
    'Release'
  )
}

function missingNativeFiles(dir) {
  return WIN_PTY_RELEASE_FILES.filter((f) => !fs.existsSync(path.join(dir, f)))
}

function assertWinPtyNatives(dir, label) {
  const missing = missingNativeFiles(dir)
  if (missing.length === 0) return
  throw new Error(
    `[pack] ${label} is missing node-pty Windows natives:\n` +
      missing.map((f) => `  - ${f}`).join('\n') +
      `\n  looked in ${dir}\n` +
      '  Run `npm run setup` before packaging. node-pty\'s npm `files` field omits build/; beforePack patches it in.'
  )
}

function ensureNodePtyShipsBuild(projectDir) {
  const pkgPath = path.join(projectDir, 'node_modules', 'node-pty', 'package.json')
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
  const files = Array.isArray(pkg.files) ? [...pkg.files] : []
  const already = files.some((f) => String(f).replace(/\\/g, '/').split('/')[0] === 'build')
  if (already) return false
  pkg.files = [...files, 'build/']
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
  return true
}

function prepareNodePtyForPack(projectDir, platformName = process.platform) {
  const pkgPath = path.join(projectDir, 'node_modules', 'node-pty', 'package.json')
  if (!fs.existsSync(pkgPath)) {
    throw new Error(`[pack] node-pty is not installed at ${pkgPath}. Run npm install --ignore-scripts && npm run setup.`)
  }
  if (platformName === 'win32') {
    assertWinPtyNatives(releaseDirFromProject(projectDir), 'source tree')
  }
  if (ensureNodePtyShipsBuild(projectDir)) {
    console.log('[pack] patched node-pty package.json files to include build/ (ConPTY natives)')
  }
}

async function beforePack(context) {
  prepareNodePtyForPack(context.packager.projectDir, context.electronPlatformName)
}

async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return
  assertWinPtyNatives(releaseDirFromApp(context.appOutDir), 'packaged app')
}

module.exports = {
  WIN_PTY_RELEASE_FILES,
  missingNativeFiles,
  assertWinPtyNatives,
  ensureNodePtyShipsBuild,
  prepareNodePtyForPack,
  beforePack,
  afterPack
}
