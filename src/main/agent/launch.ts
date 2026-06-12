import { execSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { BridgeInfo } from '../mcp/server'
import { buildAgentsMd } from './context'
import { PI_EXTENSION_SOURCE } from './extension'

/** Resolve the interactive `pi` binary on PATH. Falls back to the bare name. */
export function resolvePiBin(): string {
  if (process.platform === 'win32') {
    // npm creates a bare `pi` shim next to a `pi.cmd` shim for global packages
    // on Windows. The bare shim is often a POSIX shell script (intended for
    // git-bash / MSYS / WSL); CreateProcessW can't run it, which surfaces as
    // error 193 (ERROR_BAD_EXE_FORMAT) from node-pty. The `.cmd` / `.bat` /
    // `.exe` shim is a real Windows batch/PE file that resolves the same
    // `dist/cli.js` entry point via node, so prefer those. Fall back to the
    // first match only if no Windows shim exists; if the install only has
    // the POSIX shim the user will see a clear error 193 and can fix it.
    try {
      const out = execSync('where pi', { encoding: 'utf8' })
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
      /* pi not on PATH; fall through to literal name */
    }
    return 'pi.cmd'
  }
  try {
    const out = execSync('command -v pi', { encoding: 'utf8' })
      .split(/\r?\n/)
      .find((l) => l.trim())
    if (out && out.trim()) return out.trim()
  } catch {
    /* fall through */
  }
  return 'pi'
}

export interface AgentLaunchSpec {
  bin: string
  args: string[]
  cwd: string
  env: Record<string, string>
  cleanup: () => void
}

/**
 * Prepare a per-session working directory containing an AGENTS.md (the host
 * briefing pi auto-loads) and a pi extension that bridges pi's tool system to
 * our in-process MCP server, and return the spawn spec for interactive `pi`.
 *
 * The extension is loaded with `-e <absolute-path>`. Bridge URL + bearer
 * token travel through env vars (`DEVTERM_BRIDGE_URL`, `DEVTERM_BRIDGE_TOKEN`)
 * rather than being serialised into the file on disk.
 */
export function prepareAgentLaunch(hostContextMd: string, bridge: BridgeInfo): AgentLaunchSpec {
  const cwd = mkdtempSync(join(tmpdir(), 'devterm-agent-'))
  writeFileSync(join(cwd, 'AGENTS.md'), hostContextMd, { mode: 0o600 })
  const extensionPath = join(cwd, 'devterm-mcp.mjs')
  writeFileSync(extensionPath, PI_EXTENSION_SOURCE, { mode: 0o600 })

  return {
    bin: resolvePiBin(),
    args: [
      '--no-session', // don't save sessions to ~/.pi/agent/sessions/
      '--no-builtin-tools', // scope the agent to the MCP tools; no local fs/shell
      '-e', extensionPath, // load our MCP bridge adapter
      // The MCP server is already strict (localhost + bearer token). Disable
      // pi's startup network chatter to keep the agent pane quiet and avoid
      // surprise calls to pi.dev during an interactive session.
      '--offline'
    ],
    cwd,
    env: {
      DEVTERM_BRIDGE_URL: bridge.url,
      DEVTERM_BRIDGE_TOKEN: bridge.token
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

export { buildAgentsMd }
