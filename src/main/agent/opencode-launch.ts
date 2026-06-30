import { execSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { BridgeInfo } from '../mcp/server'
import type { AgentLaunchSpec } from './launch'
import { buildOpencodeMd } from './context'

/**
 * Resolve the interactive `opencode` binary. Never invoked with -p / SDK mode.
 *
 * Mirrors the pi resolution quirk: npm writes a POSIX-shell `opencode` shim
 * alongside the Windows `.cmd` shim, and CreateProcessW can't run the POSIX
 * one (error 193). Prefer the `.cmd` / `.bat` / `.exe` shim on Windows; fall
 * back to whatever `where` finds first if only the POSIX shim is present so
 * the user gets a clear 193 to fix rather than a silent wrong pick.
 */
export function resolveOpencodeBin(): string {
  if (process.platform === 'win32') {
    try {
      const out = execSync('where opencode', { encoding: 'utf8' })
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
      /* opencode not on PATH; fall through to literal name */
    }
    return 'opencode.cmd'
  }
  try {
    const out = execSync('command -v opencode', { encoding: 'utf8' })
      .split(/\r?\n/)
      .find((l) => l.trim())
    if (out && out.trim()) return out.trim()
  } catch {
    /* fall through */
  }
  return 'opencode'
}

/**
 * Prepare a per-session working directory containing an `opencode.json` that
 * wires the in-process MCP bridge as a remote server, and return the spawn
 * spec for interactive `opencode` scoped to the bridge tools. NEVER `--prompt`
 * / non-interactive mode.
 *
 * OpenCode supports MCP via project-level `opencode.json` with a `mcp.<name>`
 * block; a `remote` entry is just `url` + `headers`. Unlike Claude's
 * `--mcp-config` or pi's loaded extension, opencode also has built-in file
 * and bash tools; the briefing file steers the agent toward the bridge, and
 * the config disables every built-in tool so the only thing it can act on
 * the host with is the `devterm_*` MCP tools. The config also disables
 * autoupdate (the bridge is short-lived — an update prompt mid-session is
 * noise) and share/upload defaults, and pins the server port so the agent
 * can't claim another host's address book.
 */
export function prepareOpencodeLaunch(hostContextMd: string, bridge: BridgeInfo): AgentLaunchSpec {
  const cwd = mkdtempSync(join(tmpdir(), 'devterm-opencode-'))
  writeFileSync(join(cwd, 'AGENTS.md'), hostContextMd, { mode: 0o600 })

  const opencodeConfig = {
    $schema: 'https://opencode.ai/config.json',
    mcp: {
      devterm: {
        type: 'remote',
        url: bridge.url,
        enabled: true,
        headers: {
          Authorization: `Bearer ${bridge.token}`
        }
      }
    },
    // Scope the agent to MCP tools only. OpenCode ships these built-in tools
    // (https://opencode.ai/docs/tools/) — turning every one off means every
    // host action has to go through `devterm_*`, which the bridge policy-gates.
    // Earlier revisions named `patch`, `task`, `todoread` and missed
    // `apply_patch` / `websearch` / `lsp` / `question`: the real tool is
    // `apply_patch` (NOT `patch` — opencode explicitly distinguishes them in
    // its tool-execute hooks), `task` / `todoread` are not built-in tool names
    // at all, and the schema rejects unknown keys the same way it rejects
    // `server.port: 0` (see the comment on `server` below). The `tools`
    // section matches by exact tool name, not pattern.
    tools: {
      bash: false,
      read: false,
      write: false,
      edit: false,
      apply_patch: false,
      glob: false,
      grep: false,
      lsp: false,
      webfetch: false,
      websearch: false,
      skill: false,
      todowrite: false,
      question: false
    },
    // The bridge is a 5-second-lived localhost HTTP endpoint. autoupdate
    // would interrupt the session with a download prompt; sharing would try
    // to upload session JSON to opencode.ai and break the air-gapped rule;
    // snapshot is local-only but adds startup indexing cost we don't need.
    autoupdate: false,
    share: 'disabled',
    snapshot: false,
    server: {
      // Force the bundled HTTP server onto localhost so the TUI can't pick a
      // routable address; port 0 = OS-assigned. The MCP bridge has its own
      // localhost port — this is the opencode control server the TUI talks to.
      hostname: '127.0.0.1',
      port: 0
    }
  }
  writeFileSync(
    join(cwd, 'opencode.json'),
    JSON.stringify(opencodeConfig, null, 2),
    { mode: 0o600 }
  )

  return {
    bin: resolveOpencodeBin(),
    // `opencode [project]` is the default command — when no subcommand is
    // given, opencode starts the TUI against the project at `[project]` (or
    // cwd). The TUI loads the bridge MCP server from `opencode.json` in cwd.
    args: [cwd],
    cwd,
    // OPENCODE_CONFIG points opencode at the per-session config file we just
    // wrote. Setting it via env rather than relying on project-file discovery
    // (which walks up to the nearest git root and may pick up the user's
    // real project config) keeps the session fully isolated.
    env: {
      OPENCODE_CONFIG: join(cwd, 'opencode.json')
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

export { buildOpencodeMd }
