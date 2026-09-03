import { statSync } from 'fs'
import type { AgentKind } from '@shared/types'
import { resolvePiBin } from './launch'
import { resolveClaudeBin } from './claude-launch'
import { resolveOpencodeBin } from './opencode-launch'
import { resolveKimiBin } from './kimi-launch'
import { resolveGrokBin } from './grok-launch'
import { resolveCodexBin } from './codex-launch'
import { resolveAntigravityBin } from './antigravity-launch'

function agentBinLabel(kind: AgentKind): string {
  switch (kind) {
    case 'devterm':
      return 'DevTerm Agent'
    case 'claude':
      return 'Claude'
    case 'opencode':
      return 'OpenCode'
    case 'kimi':
      return 'Kimi'
    case 'grok':
      return 'Grok'
    case 'codex':
      return 'Codex'
    case 'antigravity':
      return 'Antigravity'
    default:
      return 'Pi'
  }
}

/**
 * Resolve the OS binary for a delegate target kind. Returns `undefined` for
 * the bundled DevTerm agent, whose Node runtime + CLI ship inside the app and
 * are validated at launch time instead.
 */
export async function resolveAgentBin(kind: AgentKind): Promise<string | undefined> {
  switch (kind) {
    case 'devterm':
      return undefined
    case 'pi':
      return resolvePiBin()
    case 'claude':
      return resolveClaudeBin()
    case 'opencode':
      return resolveOpencodeBin()
    case 'kimi':
      return resolveKimiBin()
    case 'grok':
      return resolveGrokBin()
    case 'codex':
      return resolveCodexBin()
    case 'antigravity':
      return resolveAntigravityBin()
  }
}

/** True when a resolved binary names a real path rather than a bare fallback. */
export function isBinPath(bin: string): boolean {
  return bin.includes('/') || bin.includes('\\')
}

export interface NormalizedHandoffModel {
  /** Model value safe to pass to the target CLI, or undefined for its default. */
  model?: string
  /** Human-readable notes for the delegate receipt + worker prompt. */
  warnings: string[]
}

/**
 * Orca-style flag discipline for delegated launches: only pass a requested
 * model flag the target launcher can actually honor. OpenCode's `--model`
 * takes `provider/model` — a free-form name (e.g. "muse spark 1.3 free")
 * makes the TUI error out on startup, so it is dropped with a warning and the
 * worker starts on the operator default instead of dying. Every other CLI
 * takes free-form model ids/aliases and validates them visibly itself, so the
 * value passes through untouched.
 */
export function normalizeHandoffModel(kind: AgentKind, model: string | undefined): NormalizedHandoffModel {
  if (!model) return { model: undefined, warnings: [] }
  if (kind === 'opencode' && !isOpencodeModelRef(model)) {
    return {
      model: undefined,
      warnings: [
        `Requested model "${model}" is not a valid OpenCode model (expected provider/model, e.g. anthropic/claude-sonnet-4) — starting with the operator default model.`
      ]
    }
  }
  return { model, warnings: [] }
}

function isOpencodeModelRef(model: string): boolean {
  // provider/model, no whitespace: exactly what `opencode --model` documents.
  return model.includes('/') && !/\s/.test(model)
}

/**
 * Fail fast when the requested agent CLI is clearly not installed, before the
 * caller opens a visible tab for it. Every resolver falls back to a bare
 * command name when its `where` / `command -v` lookup misses, so a bare name
 * (or a stale absolute path) means spawning would die in the new pane a
 * second later. Throwing here turns that into one immediate, actionable tool
 * error the delegating agent can relay to the operator.
 */
export async function assertAgentBinAvailable(kind: AgentKind): Promise<void> {
  if (kind === 'devterm') return
  const label = agentBinLabel(kind)
  let bin: string
  try {
    const resolved = await resolveAgentBin(kind)
    if (!resolved || !resolved.trim()) throw new Error('empty resolution')
    bin = resolved.trim()
  } catch {
    throw new Error(
      `Could not locate the ${label} CLI on this machine. ` +
        `Tell the operator to install it and retry — do not try to install it yourself.`
    )
  }
  if (!isBinPath(bin)) {
    throw new Error(
      `The ${label} CLI is not installed or not on PATH (looked for \`${bin}\`). ` +
        `Tell the operator to install it and retry — do not try to install it yourself ` +
        `or launch anything by hand.`
    )
  }
  let isFile = false
  try {
    isFile = statSync(bin).isFile()
  } catch {
    isFile = false
  }
  if (!isFile) {
    throw new Error(
      `The ${label} CLI was not found at \`${bin}\`. ` +
        `Tell the operator to fix the install and retry — do not try to repair it yourself.`
    )
  }
}
