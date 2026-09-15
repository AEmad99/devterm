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

function mirrorAgentClosure(projectDir, appOutDir) {
  const src = nestedClosureSource(projectDir)
  if (!fs.existsSync(src)) {
    throw new Error(
      `[pack] agent nested closure is missing at ${src}. Run \`npm run setup\` before packaging.`
    )
  }
  const dest = nestedClosureDest(appOutDir)
  fs.mkdirSync(dest, { recursive: true })
  fs.cpSync(src, dest, { recursive: true, force: true })
  return fs.readdirSync(dest).length
}

async function afterPack(context) {
  const mirrored = mirrorAgentClosure(context.packager.projectDir, context.appOutDir)
  console.log(`[pack] mirrored agent nested closure (${mirrored} entries) into app.asar.unpacked`)
}

module.exports = {
  nestedClosureSource,
  nestedClosureDest,
  mirrorAgentClosure,
  afterPack
}
