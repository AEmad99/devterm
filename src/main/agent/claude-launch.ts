import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { BridgeInfo } from '../mcp/server'
import { resolveCached } from './launch'
import type { AgentLaunchSpec } from './launch'
import { buildClaudeMd } from './context'

/**
 * Resolve the interactive `claude` binary. Never invoked with -p / SDK mode.
 *
 * Same Windows quirk as the pi / opencode resolvers: npm writes a POSIX-shell
 * `claude` shim alongside the Windows `.cmd` shim, and CreateProcessW can't
 * run the POSIX one (error 193). Prefer the `.cmd` / `.bat` / `.exe` shim on
 * Windows so node-pty can actually launch it.
 */
export async function resolveClaudeBin(): Promise<string> {
  return resolveCached('claude', 'claude.cmd', 'claude')
}

/**
 * Prepare a working directory with a per-session CLAUDE.md and an --mcp-config
 * pointing at the localhost bridge (URL + bearer token), and return the spawn
 * spec for interactive `claude` scoped to the bridge tools. NEVER `-p`.
 *
 * Unlike the pi launch, the bridge is wired through Claude's native
 * `--mcp-config` (HTTP transport + bearer header) rather than a loaded
 * extension, so no bridge env vars are needed — `env` is empty but kept so the
 * spec matches {@link AgentLaunchSpec}.
 */
export async function prepareClaudeLaunch(
  claudeMd: string,
  bridge: BridgeInfo
): Promise<AgentLaunchSpec> {
  const cwd = mkdtempSync(join(tmpdir(), 'devterm-claude-'))
  writeFileSync(join(cwd, 'CLAUDE.md'), claudeMd, { mode: 0o600 })

  const mcpConfig = {
    mcpServers: {
      devterm: {
        type: 'http',
        url: bridge.url,
        headers: { Authorization: `Bearer ${bridge.token}` }
      }
    }
  }
  const mcpPath = join(cwd, 'mcp-config.json')
  writeFileSync(mcpPath, JSON.stringify(mcpConfig, null, 2), { mode: 0o600 })

  return {
    bin: await resolveClaudeBin(),
    args: [
      '--mcp-config',
      mcpPath,
      '--strict-mcp-config',
      '--permission-mode',
      'bypassPermissions',
      '--dangerously-skip-permissions',
      // `--allowedTools` takes repeated positional values — one rule per arg.
      // The earlier single comma-string form was parsed by Claude as one glob
      // pattern ('mcp__devterm__*,Read,Write,Edit') that matched no actual tool
      // name, so every MCP tool call was rejected and the agent looked broken.
      // The glob `mcp__devterm__*` matches every DevTerm MCP tool (Claude's
      // docs describe its --allowedTools as accepting pattern matching); Read
      // / Write / Edit stay enabled for the agent's local CLAUDE.md scratch.
      '--allowedTools',
      'mcp__devterm__*',
      '--allowedTools',
      'Read',
      '--allowedTools',
      'Write',
      '--allowedTools',
      'Edit'
    ],
    cwd,
    env: {},
    cleanup: () => {
      try {
        rmSync(cwd, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
  }
}

export { buildClaudeMd }
