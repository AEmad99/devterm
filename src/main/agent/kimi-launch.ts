import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { BridgeInfo } from '../mcp/server'
import { resolveCached } from './launch'
import type { AgentLaunchExtras, AgentLaunchSpec } from './launch'
import { buildKimiMd } from './context'

/**
 * Resolve the interactive `kimi` binary (Moonshot AI Kimi Code CLI). Never
 * invoked in non-interactive mode.
 *
 * Mirrors the pi / claude / opencode resolution quirk: npm writes a
 * POSIX-shell `kimi` shim alongside the Windows `.cmd` shim, and CreateProcessW
 * can't run the POSIX one (error 193). Prefer the `.cmd` / `.bat` / `.exe`
 * shim on Windows; fall back to whatever `where` finds first if only the POSIX
 * shim is present so the user gets a clear 193 to fix rather than a silent
 * wrong pick.
 */
export async function resolveKimiBin(): Promise<string> {
  return resolveCached('kimi', 'kimi.cmd', 'kimi')
}

/**
 * Prepare a per-session working directory containing an `AGENTS.md` briefing
 * and a `.kimi-code/mcp.json` that wires the in-process MCP bridge as an HTTP
 * server, and return the spawn spec for interactive `kimi` scoped to the bridge
 * tools. NEVER non-interactive / `--prompt` mode.
 *
 * Kimi Code CLI auto-discovers project-level MCP servers from
 * `.kimi-code/mcp.json` in the working directory, and auto-loads `AGENTS.md`
 * from the project hierarchy. Remote launches use the temp dir as cwd so Kimi
 * picks up that isolated file. Native local still writes the file in the
 * overlay (never the operator tree — it holds a bearer token) and runs with
 * cwd = the project; without a Kimi equivalent of GROK_HOME, browser MCP may
 * not load until Kimi grows a config-dir flag. Kimi does not support a
 * `--mcp-config-file` flag.
 */
export async function prepareKimiLaunch(
  hostContextMd: string,
  bridge: BridgeInfo,
  extras?: AgentLaunchExtras
): Promise<AgentLaunchSpec> {
  const overlay = mkdtempSync(join(tmpdir(), 'devterm-kimi-'))
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
  const kimiCodeDir = join(overlay, '.kimi-code')
  mkdirSync(kimiCodeDir, { recursive: true })
  writeFileSync(join(kimiCodeDir, 'mcp.json'), JSON.stringify(mcpConfig, null, 2), { mode: 0o600 })

  // `-m` selects a model alias for this launch and keeps the interactive TUI.
  // `-p` would switch to non-interactive print mode, so the handoff prompt is
  // NOT passed here — the renderer types it into the TUI after startup.
  const args: string[] = []
  const model = extras?.model?.trim()
  if (model) args.push('--model', model)

  return {
    bin: await resolveKimiBin(),
    args,
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

export { buildKimiMd }
