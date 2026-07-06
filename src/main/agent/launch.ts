import { execFile } from 'child_process'
import { promisify } from 'util'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { BridgeInfo } from '../mcp/server'
import { buildAgentsMd } from './context'
import { PI_EXTENSION_SOURCE } from './extension'

const execFileAsync = promisify(execFile)
const binCache = new Map<string, string>()

async function resolveOnWindows(name: string): Promise<string | undefined> {
  // npm creates a bare `pi` shim next to a `pi.cmd` shim for global packages
  // on Windows. The bare shim is often a POSIX shell script (intended for
  // git-bash / MSYS / WSL); CreateProcessW can't run it, which surfaces as
  // error 193 (ERROR_BAD_EXE_FORMAT) from node-pty. The `.cmd` / `.bat` /
  // `.exe` shim is a real Windows batch/PE file that resolves the same
  // entry point via node, so prefer those. Fall back to the first match only
  // if no Windows shim exists; if the install only has the POSIX shim the user
  // will see a clear error 193 and can fix it.
  try {
    const { stdout } = await execFileAsync('where', [name], { encoding: 'utf8' })
    const out = stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
    const winShim = out.find(
      (p) =>
        p.toLowerCase().endsWith('.cmd') ||
        p.toLowerCase().endsWith('.bat') ||
        p.toLowerCase().endsWith('.exe')
    )
    return winShim || out[0]
  } catch {
    return undefined
  }
}

async function resolveOnPosix(name: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('command', ['-v', name], { encoding: 'utf8' })
    const out = stdout.split(/\r?\n/).find((l) => l.trim())
    return out?.trim()
  } catch {
    return undefined
  }
}

export async function resolveCached(
  name: string,
  winFallback: string,
  posixFallback: string
): Promise<string> {
  const cached = binCache.get(name)
  if (cached) return cached
  const resolved =
    process.platform === 'win32'
      ? ((await resolveOnWindows(name)) ?? winFallback)
      : ((await resolveOnPosix(name)) ?? posixFallback)
  binCache.set(name, resolved)
  return resolved
}

/** Resolve the interactive `pi` binary on PATH. Falls back to the bare name. */
export async function resolvePiBin(): Promise<string> {
  return resolveCached('pi', 'pi.cmd', 'pi')
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
export async function prepareAgentLaunch(
  hostContextMd: string,
  bridge: BridgeInfo
): Promise<AgentLaunchSpec> {
  const cwd = mkdtempSync(join(tmpdir(), 'devterm-agent-'))
  writeFileSync(join(cwd, 'AGENTS.md'), hostContextMd, { mode: 0o600 })
  const extensionPath = join(cwd, 'devterm-mcp.mjs')
  writeFileSync(extensionPath, PI_EXTENSION_SOURCE, { mode: 0o600 })

  return {
    bin: await resolvePiBin(),
    args: [
      '--no-session', // don't save sessions to ~/.pi/agent/sessions/
      '--no-builtin-tools', // scope the agent to the MCP tools; no local fs/shell
      '-e',
      extensionPath, // load our MCP bridge adapter
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
