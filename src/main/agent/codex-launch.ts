import { execSync } from 'child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import type { BridgeInfo } from '../mcp/server'
import type { AgentLaunchSpec } from './launch'
import { buildCodexMd } from './context'

/**
 * Resolve the interactive `codex` binary. Never invoked with `exec` / headless mode.
 *
 * npm places a POSIX `codex` shim next to `codex.cmd` on Windows; CreateProcessW
 * cannot run the POSIX one (error 193). Prefer `.cmd` / `.bat` / `.exe`, then the
 * standalone installer under `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin\`.
 */
export function resolveCodexBin(): string {
  const standalone =
    process.platform === 'win32'
      ? join(process.env.LOCALAPPDATA ?? '', 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe')
      : join(homedir(), '.local', 'bin', 'codex')
  if (existsSync(standalone)) return standalone

  if (process.platform === 'win32') {
    try {
      const out = execSync('where codex', { encoding: 'utf8' })
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
      /* codex not on PATH; fall through */
    }
    return 'codex.cmd'
  }
  try {
    const out = execSync('command -v codex', { encoding: 'utf8' })
      .split(/\r?\n/)
      .find((l) => l.trim())
    if (out && out.trim()) return out.trim()
  } catch {
    /* fall through */
  }
  return 'codex'
}

/**
 * Prepare a per-session working directory containing an `AGENTS.md` briefing and
 * an isolated `CODEX_HOME` with a `config.toml` that wires the in-process MCP
 * bridge as a streamable HTTP server. Returns the spawn spec for interactive
 * `codex` — NEVER `codex exec` / non-interactive mode.
 *
 * Codex discovers MCP servers from `config.toml` under `CODEX_HOME`. DevTerm
 * points `CODEX_HOME` at a throwaway directory (copying `auth.json` from the
 * operator's real install when present) so the session does not inherit the
 * user's global MCP servers or shell-tool settings. Built-in shell access stays
 * off via `features.shell_tool = false`; host work goes through `mcp__devterm__*`.
 * Approval prompts stay in Codex — DevTerm does not write `approval_policy`.
 */
export function prepareCodexLaunch(hostContextMd: string, bridge: BridgeInfo): AgentLaunchSpec {
  const cwd = mkdtempSync(join(tmpdir(), 'devterm-codex-'))
  const codexHome = join(cwd, 'codex-home')
  mkdirSync(codexHome, { recursive: true })

  writeFileSync(join(cwd, 'AGENTS.md'), hostContextMd, { mode: 0o600 })

  const userAuth = join(homedir(), '.codex', 'auth.json')
  if (existsSync(userAuth)) {
    copyFileSync(userAuth, join(codexHome, 'auth.json'))
  }

  const codexConfig = `# DevTerm per-session isolated Codex config
sandbox_mode = "read-only"
web_search = "disabled"

[history]
persistence = "none"

[features]
shell_tool = false

[mcp_servers.devterm]
enabled = true
required = true
url = "${bridge.url}"

[mcp_servers.devterm.http_headers]
Authorization = "Bearer ${bridge.token}"
`
  writeFileSync(join(codexHome, 'config.toml'), codexConfig, { mode: 0o600 })

  // Sandbox stays read-only so host work goes through MCP. Do not pass
  // `--ask-for-approval`: Codex owns its permission UI.
  const args = ['--sandbox', 'read-only']

  return {
    bin: resolveCodexBin(),
    args,
    cwd,
    env: {
      CODEX_HOME: codexHome
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

export { buildCodexMd }
