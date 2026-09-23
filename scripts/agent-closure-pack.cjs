'use strict'

/**
 * Packaging helper for the bundled DevTerm Agent's nested dependency closure.
 *
 * npm nests `@earendil-works/pi-coding-agent`'s version-conflicted dependencies
 * under `pi-coding-agent/node_modules/` (typebox, partial-json, undici, ...).
 * electron-builder's production-deps collection does not carry that nested
 * closure into the package, and no asarUnpack pattern restores it, so the
 * external agent node fails with ERR_MODULE_NOT_FOUND on the first nested-only
 * import. afterPack mirrors the dev nested closure into app.asar.unpacked,
 * where Node resolves it exactly as in development. Merging (not replacing)
 * keeps whatever the builder did collect.
 */

const fs = require('fs')
const path = require('path')

const PI_PKG_SEGMENTS = ['@earendil-works', 'pi-coding-agent']

function nestedClosureSource(projectDir) {
  return path.join(projectDir, 'node_modules', ...PI_PKG_SEGMENTS, 'node_modules')
}

function nestedClosureDest(appOutDir) {
  return path.join(
    appOutDir,
    'resources',
    'app.asar.unpacked',
    'node_modules',
    ...PI_PKG_SEGMENTS,
    'node_modules'
  )
}

const SKIP_DIR_NAMES = new Set([
  'docs',
  'doc',
  'examples',
  'example',
  'test',
  'tests',
  '__tests__',
  '.github'
])

/** builder-util Arch enum → esbuild package arch. */
function archName(arch) {
  if (typeof arch === 'string') return arch
  return { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' }[arch] || 'x64'
}

function esbuildTarget(platform, arch) {
  if (!platform) return null
  const name = archName(arch)
  if (platform === 'win32') return `win32-${name === 'arm64' ? 'arm64' : name === 'ia32' ? 'ia32' : 'x64'}`
  if (platform === 'darwin') return `darwin-${name === 'arm64' ? 'arm64' : 'x64'}`
  if (platform === 'linux') return `linux-${name === 'arm64' ? 'arm64' : name === 'armv7l' ? 'arm' : 'x64'}`
  return null
}

function shouldMirrorFile(rel, target) {
  const parts = rel.split('/')
  if (parts.some((part) => SKIP_DIR_NAMES.has(part))) return false
  const base = parts[parts.length - 1]
  if (
    base.endsWith('.map') ||
    base.endsWith('.md') ||
    base.endsWith('.d.ts') ||
    base.endsWith('.d.mts') ||
    base.endsWith('.d.cts')
  ) {
    return false
  }
  const esbuild = rel.match(/(?:^|\/)@esbuild\/([^/]+)/)
  if (esbuild && target && esbuild[1] !== target) return false
  return true
}

function mirrorAgentClosure(projectDir, appOutDir, opts = {}) {
  const src = nestedClosureSource(projectDir)
  if (!fs.existsSync(src)) {
    throw new Error(
      `[pack] agent nested closure is missing at ${src}. Run \`npm run setup\` before packaging.`
    )
  }
  const dest = nestedClosureDest(appOutDir)
  const target = esbuildTarget(opts.platform, opts.arch)
  fs.mkdirSync(dest, { recursive: true })
  fs.cpSync(src, dest, {
    recursive: true,
    force: true,
    filter: (source) => {
      const rel = path.relative(src, source).replace(/\\/g, '/')
      if (!rel) return true
      return shouldMirrorFile(rel, target)
    }
  })
  return fs.readdirSync(dest).length
}

async function afterPack(context) {
  const mirrored = mirrorAgentClosure(context.packager.projectDir, context.appOutDir, {
    platform: context.electronPlatformName,
    arch: context.arch
  })
  console.log(`[pack] mirrored agent nested closure (${mirrored} entries) into app.asar.unpacked`)
}

module.exports = {
  nestedClosureSource,
  nestedClosureDest,
  mirrorAgentClosure,
  shouldMirrorFile,
  esbuildTarget,
  afterPack
}
