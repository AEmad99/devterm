import { execSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { BridgeInfo } from '../mcp/server'
import type { AgentLaunchSpec } from './launch'
import { buildClaudeMd } from './context'

/** Resolve the interactive `claude` binary. Never invoked with -p / SDK mode. */
export function resolveClaudeBin(): string {
  const cmd = process.platform === 'win32' ? 'where claude' : 'command -v claude'
  try {
    const out = execSync(cmd, { encoding: 'utf8' })
      .split(/\r?\n/)
      .find((l) => l.trim())
    if (out && out.trim()) return out.trim()
  } catch {
    /* fall through */
  }
  return 'claude'
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
export function prepareClaudeLaunch(claudeMd: string, bridge: BridgeInfo): AgentLaunchSpec {
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
    bin: resolveClaudeBin(),
    args: [
      '--mcp-config',
      mcpPath,
      '--strict-mcp-config',
      '--permission-mode',
      'bypassPermissions',
      '--dangerously-skip-permissions',
      '--allowedTools',
      'mcp__devterm__*,Read,Write,Edit'
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
