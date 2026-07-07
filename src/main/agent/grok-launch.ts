import { execSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import type { PolicyMode } from '@shared/types'
import type { BridgeInfo } from '../mcp/server'
import type { AgentLaunchSpec } from './launch'
import { buildGrokMd } from './context'

/**
 * Resolve the interactive `grok` binary. Never invoked with `-p` / headless mode.
 *
 * The official installer places `grok.exe` under `~/.grok/bin/`. On Windows,
 * also prefer a `.exe` shim from `where` over any POSIX shell wrapper.
 */
export function resolveGrokBin(): string {
  const homeBin =
    process.platform === 'win32'
      ? join(homedir(), '.grok', 'bin', 'grok.exe')
      : join(homedir(), '.grok', 'bin', 'grok')
  if (existsSync(homeBin)) return homeBin

  if (process.platform === 'win32') {
    try {
      const out = execSync('where grok', { encoding: 'utf8' })
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
      const winShim = out.find(
        (p) =>
          p.toLowerCase().endsWith('.cmd') ||
          p.toLowerCase().endsWith('.bat') ||
          p.toLowerCase().endsWith('.exe')
      )
      if (winShim) return winShim
      if (out[0]) return out[0]
    } catch {
      /* grok not on PATH; fall through */
    }
    return 'grok.exe'
  }
  try {
    const out = execSync('command -v grok', { encoding: 'utf8' })
      .split(/\r?\n/)
      .find((l) => l.trim())
    if (out && out.trim()) return out.trim()
  } catch {
    /* fall through */
  }
  return 'grok'
}

/**
 * Prepare a per-session working directory containing an `AGENTS.md` briefing,
 * a project-scoped `.grok/config.toml` that wires the in-process MCP bridge as
 * an HTTP server, and a `.claude/settings.json` allow-list that scopes the
 * session to `devterm__*` MCP tools only. Returns the spawn spec for
 * interactive `grok` — NEVER `-p` / headless mode.
 *
 * Grok discovers project MCP servers from `.grok/config.toml` in cwd. The
 * bearer token never leaves the temp dir's config file (mode 0o600). DevTerm's
 * bridge policy (read-only / confirm / full) remains the real authorization
 * boundary, so Grok itself auto-approves MCP tool calls.
 */
export function prepareGrokLaunch(
  hostContextMd: string,
  bridge: BridgeInfo,
  _policyMode: PolicyMode
): AgentLaunchSpec {
  const cwd = mkdtempSync(join(tmpdir(), 'devterm-grok-'))
  const grokDir = join(cwd, '.grok')
  const claudeDir = join(cwd, '.claude')
  mkdirSync(grokDir, { recursive: true })
  mkdirSync(claudeDir, { recursive: true })

  writeFileSync(join(cwd, 'AGENTS.md'), hostContextMd, { mode: 0o600 })

  const grokConfig = `[mcp_servers.devterm]
url = "${bridge.url}"
enabled = true

[mcp_servers.devterm.headers]
Authorization = "Bearer ${bridge.token}"
`
  writeFileSync(join(grokDir, 'config.toml'), grokConfig, { mode: 0o600 })

  // Deny-by-default at the Grok layer: only the DevTerm MCP tools are allowed.
  // Host mutations are gated by the bridge's policy, not Grok's local bash/edit.
  const claudeSettings = {
    defaultMode: 'dontAsk',
    permissions: {
      allow: ['MCPTool(devterm__*)']
    }
  }
  writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify(claudeSettings, null, 2), {
    mode: 0o600
  })

  return {
    bin: resolveGrokBin(),
    args: [
      // DevTerm's bridge policy is the real gate; skip Grok's redundant MCP prompts.
      '--always-approve',
      // Remote-bridge sessions don't need web tools; keeps air-gapped hosts quiet.
      '--disable-web-search',
      // Embedded pane: one agent, no subagent fan-out.
      '--no-subagents'
    ],
    cwd,
    env: {
      // The temp dir is throwaway DevTerm state, not an operator project tree.
      // Skip the folder-trust gate so the per-session MCP config loads immediately.
      GROK_FOLDER_TRUST: '0'
    },
    cleanup: () => {
      try {
        rmSync(cwd, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
  }
}

export { buildGrokMd }
