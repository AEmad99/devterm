import { execSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import type { BridgeInfo } from '../mcp/server'
import type { AgentLaunchExtras, AgentLaunchSpec } from './launch'
import { resolveCached } from './launch'
import { buildAntigravityMd } from './context'

/**
 * Resolve the interactive `agy` / `antigravity` binary (Google Antigravity CLI).
 *
 * Checks standard install paths (`~/.gemini/antigravity-cli/bin/`), Windows `.cmd` / `.exe` shims,
 * and PATH via `where` / `command -v`.
 */
export async function resolveAntigravityBin(): Promise<string> {
  const homeBin =
    process.platform === 'win32'
      ? join(homedir(), '.gemini', 'antigravity-cli', 'bin', 'agy.exe')
      : join(homedir(), '.gemini', 'antigravity-cli', 'bin', 'agy')
  if (existsSync(homeBin)) return homeBin

  const altHomeBin =
    process.platform === 'win32'
      ? join(homedir(), '.gemini', 'antigravity-cli', 'bin', 'antigravity.exe')
      : join(homedir(), '.gemini', 'antigravity-cli', 'bin', 'antigravity')
  if (existsSync(altHomeBin)) return altHomeBin

  if (process.platform === 'win32') {
    try {
      const out = execSync('where agy antigravity', { encoding: 'utf8' })
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
      /* not found on PATH; fall through */
    }
    return resolveCached('agy', 'agy.cmd', 'agy')
  }

  return resolveCached('agy', 'agy.cmd', 'agy')
}

/**
 * Prepare a per-session working directory containing an `AGENTS.md` briefing
 * and `.antigravity/mcp.json` / `mcp.json` files wiring the in-process MCP bridge.
 * Returns the spawn spec for interactive `agy` / `antigravity`.
 *
 * Remote: cwd is the overlay, so those files are discovered. Native local: cwd
 * is the operator folder and the overlay MCP files are not on the walk — same
 * class of bug Grok had before GROK_HOME isolation. Tokens stay in the overlay.
 */
export async function prepareAntigravityLaunch(
  hostContextMd: string,
  bridge: BridgeInfo,
  extras?: AgentLaunchExtras
): Promise<AgentLaunchSpec> {
  const overlay = mkdtempSync(join(tmpdir(), 'devterm-antigravity-'))
  if (!extras?.nativeLocal) {
    writeFileSync(join(overlay, 'AGENTS.md'), hostContextMd, { mode: 0o600 })
  } else if (extras.appendSystemPrompt) {
    writeFileSync(join(overlay, 'DEVTERM.md'), extras.appendSystemPrompt, { mode: 0o600 })
  }

  const mcpConfig = {
    mcpServers: {
      devterm: {
        url: bridge.url,
        headers: {
          Authorization: `Bearer ${bridge.token}`
        }
      }
    }
  }

  const jsonContent = JSON.stringify(mcpConfig, null, 2)
  const antiDir = join(overlay, '.antigravity')
  mkdirSync(antiDir, { recursive: true })
  writeFileSync(join(antiDir, 'mcp.json'), jsonContent, { mode: 0o600 })

  const geminiDir = join(overlay, '.gemini', 'antigravity-cli')
  mkdirSync(geminiDir, { recursive: true })
  writeFileSync(join(geminiDir, 'mcp.json'), jsonContent, { mode: 0o600 })

  writeFileSync(join(overlay, 'mcp.json'), jsonContent, { mode: 0o600 })

  return {
    bin: await resolveAntigravityBin(),
    args: [],
    cwd: extras?.spawnCwd || overlay,
    env: {},
    cleanup: () => {
      try {
        rmSync(overlay, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
  }
}

export { buildAntigravityMd }
