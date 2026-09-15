'use strict'

// Windows integrity-label hardening for executables provisioned by setup.
//
// A Low mandatory-integrity label on an .exe (typically inherited from its
// folder, e.g. a tree extracted by a sandboxed process) makes every process
// spawned from it run at Low integrity: reads work but ALL file writes fail
// with EPERM. That silently breaks `npm run test` (npm cmd-shims resolve
// `node` to the bundled runtime via node_modules/.bin) and the dev-mode
// agent. Resetting the label to Medium restores the Windows default.
//
// Matches scripts/pty-native-pack.cjs: pure, requireable from tests, no side
// effects on load. All icacls execution stays behind functions that no-op
// off win32 (query) or throw to the caller (reset).

const { execFileSync } = require('node:child_process')

/** argv for `icacls <target> /setintegritylevel M` (no OI/CI: files only). */
function buildResetLabelArgs(target) {
  return [target, '/setintegritylevel', 'M']
}

/**
 * Reset `target` to Medium integrity. Returns false off win32; throws on
 * failure so the caller decides whether setup should continue.
 */
function resetExecutableLabel(target) {
  if (process.platform !== 'win32') return false
  execFileSync('icacls', buildResetLabelArgs(target), { stdio: 'pipe' })
  return true
}

/** True when icacls output shows a Low mandatory label. Pure string check. */
function isLowIntegrityOutput(icaclsStdout) {
  return /Low Mandatory Level/i.test(icaclsStdout ?? '')
}

/**
 * Query the integrity label of `target` ('low' | 'medium-or-higher').
 * Returns null off win32 or when icacls cannot run.
 */
function queryIntegrityLabel(target) {
  if (process.platform !== 'win32') return null
  try {
    const out = execFileSync('icacls', [target], { stdio: 'pipe', encoding: 'utf8' })
    return isLowIntegrityOutput(out) ? 'low' : 'medium-or-higher'
  } catch {
    return null
  }
}

module.exports = {
  buildResetLabelArgs,
  resetExecutableLabel,
  isLowIntegrityOutput,
  queryIntegrityLabel
}
