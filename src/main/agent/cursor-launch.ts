import { execSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import type { BridgeInfo } from '../mcp/server'
import type { AgentLaunchExtras, AgentLaunchSpec } from './launch'
import { buildCursorMd } from './context'

/**
 * Keep initial prompts below the Windows CreateProcess command-line budget.
 * Larger prompts fall back to the renderer's PTY injection.
 */
export const CURSOR_PROMPT_ARG_LIMIT = 12000

/**
 * Resolve the interactive Cursor Agent CLI (`agent` / `cursor-agent`).
 *
 * Prefer the official Windows install under `%LOCALAPPDATA%\\cursor-agent\\`
 * and the `cursor-agent` shim over a bare `agent` on PATH — Grok and other
 * tools also ship an `agent.exe`, which would otherwise win `where agent`.
 * Never invoked with `-p` / print mode.
 */
export function resolveCursorBin(): string {
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA?.trim()
    if (localAppData) {
      for (const name of ['cursor-agent.cmd', 'agent.cmd', 'cursor-agent.exe', 'agent.exe']) {
        const installed = join(localAppData, 'cursor-agent', name)
        if (existsSync(installed)) return installed
      }
    }

    try {
      const out = execSync('where cursor-agent agent', { encoding: 'utf8' })
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
      const cursorShim = out.find((path) => /cursor-agent/i.test(path))
      if (cursorShim) {
        const winShim = preferWindowsShim(
          out.filter((path) => /cursor-agent/i.test(path))
        )
        if (winShim) return winShim
        return cursorShim
      }
      // Bare `agent` matches are only safe when they live under cursor-agent/.
      const underInstall = preferWindowsShim(
        out.filter((path) => /[\\/]cursor-agent[\\/]/i.test(path))
      )
      if (underInstall) return underInstall
    } catch {
      /* Cursor CLI is not on PATH; use the standard Windows fallback below. */
    }
    return join(process.env.LOCALAPPDATA ?? '', 'cursor-agent', 'cursor-agent.cmd')
  }

  const homeBin = join(homedir(), '.local', 'bin')
  for (const name of ['cursor-agent', 'agent']) {
    const candidate = join(homeBin, name)
    if (existsSync(candidate)) return candidate
  }

  try {
    const out = execSync('command -v cursor-agent agent', { encoding: 'utf8' })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
    const cursor = out.find((path) => /cursor-agent/i.test(path))
    if (cursor) return cursor
    // Same collision risk as Windows: only accept bare `agent` from a
    // cursor-agent install prefix.
    const underInstall = out.find((path) => /\/cursor-agent\//i.test(path))
    if (underInstall) return underInstall
  } catch {
    /* fall through */
  }
  return 'cursor-agent'
}

function preferWindowsShim(paths: string[]): string | undefined {
  return (
    paths.find(
      (path) =>
        path.toLowerCase().endsWith('.cmd') ||
        path.toLowerCase().endsWith('.bat') ||
        path.toLowerCase().endsWith('.exe')
    ) ?? paths[0]
  )
}

/** MCP entry Cursor CLI accepts for DevTerm's streamable HTTP bridge. */
export function buildCursorMcpConfig(bridge: BridgeInfo): {
  mcpServers: Record<string, { type: string; url: string; headers: Record<string, string> }>
} {
  return {
    mcpServers: {
      devterm: {
        // CLI rejects `streamable-http` and silently drops the whole file;
        // `http` is the documented alias for the same transport.
        type: 'http',
        url: bridge.url,
        headers: {
          Authorization: `Bearer ${bridge.token}`
        }
      }
    }
  }
}

/**
 * Prepare an isolated Cursor Agent session wired to the DevTerm MCP bridge.
 *
 * Uses `--yolo` (alias `--force`) plus `--approve-mcps` and `--sandbox disabled`
 * so the CLI starts in “approve all permissions” mode as documented. DevTerm's
 * MCP approval rules remain a pre-check on the bridge before host tools run.
 *
 * Config home is relocated via `HOME` / `USERPROFILE` to a throwaway directory
 * that contains only our `mcp.json`, so the operator's global MCP servers and
 * permission allowlists cannot leak into a DevTerm session. Auth tokens live
 * outside that profile (OS credential store), so login state survives.
 *
 * Remote: cwd is the overlay with `AGENTS.md`; host work goes through
 * `mcp__devterm__*`. Local native: cwd is the operator folder; Cursor's own
 * tools edit the project and MCP covers browser / handoff.
 */
export function prepareCursorLaunch(
  hostContextMd: string,
  bridge: BridgeInfo,
  extras?: AgentLaunchExtras
): AgentLaunchSpec {
  const overlay = mkdtempSync(join(tmpdir(), 'devterm-cursor-'))
  const cursorHome = join(overlay, 'home')
  const cursorDir = join(cursorHome, '.cursor')
  mkdirSync(cursorDir, { recursive: true })

  writeFileSync(
    join(cursorDir, 'mcp.json'),
    JSON.stringify(buildCursorMcpConfig(bridge), null, 2),
    { mode: 0o600 }
  )

  // A permissive cli-config so --yolo is not fighting a stale allowlist copied
  // from nowhere — this home is empty aside from our MCP entry.
  writeFileSync(
    join(cursorDir, 'cli-config.json'),
    JSON.stringify(
      {
        version: 1,
        permissions: { allow: ['*'], deny: [] },
        approvalMode: 'allowlist',
        sandbox: { mode: 'disabled' }
      },
      null,
      2
    ),
    { mode: 0o600 }
  )

  if (!extras?.nativeLocal) {
    writeFileSync(join(overlay, 'AGENTS.md'), hostContextMd, { mode: 0o600 })
  } else if (extras.appendSystemPrompt) {
    const rulesDir = join(cursorDir, 'rules')
    mkdirSync(rulesDir, { recursive: true })
    writeFileSync(join(rulesDir, 'devterm-local.mdc'), extras.appendSystemPrompt, { mode: 0o600 })
  }

  // Also plant project-level mcp.json when cwd is the overlay so discovery
  // works even if a future CLI build prefers project over user config.
  if (!extras?.nativeLocal) {
    const projectCursor = join(overlay, '.cursor')
    mkdirSync(projectCursor, { recursive: true })
    writeFileSync(
      join(projectCursor, 'mcp.json'),
      JSON.stringify(buildCursorMcpConfig(bridge), null, 2),
      { mode: 0o600 }
    )
  }

  const args = [
    // Docs: --yolo / --force force-allow commands; --approve-mcps skips MCP prompts.
    '--yolo',
    '--approve-mcps',
    '--sandbox',
    'disabled'
  ]
  const model = extras?.model?.trim()
  if (model) args.push('--model', model)

  const workspace = extras?.spawnCwd || overlay
  args.push('--workspace', workspace)

  const prompt = extras?.initialPrompt?.replace(/\s+$/u, '')
  let promptDelivered = false
  if (prompt && prompt.length <= CURSOR_PROMPT_ARG_LIMIT) {
    // Positional prompt starts an interactive session (only `-p` is headless).
    args.push(prompt)
    promptDelivered = true
  }

  return {
    bin: resolveCursorBin(),
    args,
    cwd: extras?.spawnCwd || overlay,
    env: {
      // Relocate ~ so global MCP / cli-config isolation sticks on both platforms.
      HOME: cursorHome,
      USERPROFILE: cursorHome
    },
    promptDelivered,
    cleanup: () => {
      try {
        rmSync(overlay, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
  }
}

export { buildCursorMd }
