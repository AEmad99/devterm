import { execSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
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
 * Config keys lifted from the operator's real opencode config into the isolated
 * session config. We copy only what the bridged agent needs to *run* — the
 * provider definitions and model selection — plus harmless display prefs.
 * Everything else in the global config (most importantly `mcp` servers,
 * `plugin`s, and custom `agent`/`command` definitions) is deliberately left
 * behind: those can hand the agent host capabilities, and the whole point of
 * the bridge is that the agent only touches the host through `devterm_*`.
 */
const INHERITED_CONFIG_KEYS = ['provider', 'model', 'small_model', 'username', 'theme'] as const

/**
 * Best-effort read of the operator's global opencode config, returning only the
 * allowlisted keys (see {@link INHERITED_CONFIG_KEYS}). opencode resolves its
 * global config from `$XDG_CONFIG_HOME/opencode` (falling back to
 * `~/.config/opencode`) and accepts `opencode.json` or the legacy `config.json`.
 * We read the raw file — not opencode's *merged* resolution — so the operator's
 * mcp/plugin layers never tag along. Any failure (no file, or JSONC we can't
 * `JSON.parse`) degrades to `{}`: the agent then falls back to opencode's
 * built-in provider/model resolution, which still works for authed built-in
 * providers because auth lives in the data dir, which the session never moves.
 */
function inheritGlobalConfig(): Record<string, unknown> {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  const dir = join(base, 'opencode')
  for (const name of ['opencode.json', 'config.json']) {
    const file = join(dir, name)
    try {
      if (!existsSync(file)) continue
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
      const picked: Record<string, unknown> = {}
      for (const key of INHERITED_CONFIG_KEYS) {
        if (parsed[key] !== undefined) picked[key] = parsed[key]
      }
      return picked
    } catch {
      /* missing / unreadable / non-plain-JSON — try the next candidate */
    }
  }
  return {}
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
 * noise) and share/upload defaults, and pins the bundled control server to
 * localhost so it can't bind a routable address.
 *
 * Isolation: opencode has no "ignore global config" switch and only ever
 * *merges* config layers (a merge can't delete a key), so an `mcp` server in
 * the operator's `~/.config/opencode` would otherwise be handed straight to the
 * bridged agent — including `type: local` servers that spawn processes on this
 * machine, which would defeat the air-gap. We sever the global layer by pointing
 * `XDG_CONFIG_HOME` at an empty per-session dir, then lift just the operator's
 * provider/model back across (see {@link inheritGlobalConfig}) so their selected
 * model still runs. Auth/credentials live in the data dir, which we never move,
 * so authed providers keep working.
 */
export function prepareOpencodeLaunch(hostContextMd: string, bridge: BridgeInfo): AgentLaunchSpec {
  const cwd = mkdtempSync(join(tmpdir(), 'devterm-opencode-'))
  writeFileSync(join(cwd, 'AGENTS.md'), hostContextMd, { mode: 0o600 })

  // Empty config home: opencode resolves its "global" config from
  // `$XDG_CONFIG_HOME/opencode`, so pointing that env at a dir with no opencode
  // config (below) severs the operator's real global config — mcp servers,
  // plugins, agents — from this session. Must exist; opencode stats it at startup.
  const configHome = join(cwd, 'config-home')
  mkdirSync(configHome, { recursive: true })

  const opencodeConfig = {
    $schema: 'https://opencode.ai/config.json',
    // Lift the operator's provider/model (+ cosmetic prefs) across the isolation
    // boundary so their chosen model still runs. Spread first so the explicit
    // keys below always win on any conflict.
    ...inheritGlobalConfig(),
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
    // Scope the agent to MCP tools only. OpenCode ships its own bash/read/
    // write/edit/list/glob/grep/webfetch/todoread/todowrite/task; turning
    // them all off means every host action has to go through `devterm_*`,
    // which the bridge policy-gates. The MCP server's tools stay enabled
    // because the `tools` section matches by exact tool name, not pattern.
    tools: {
      bash: false,
      read: false,
      write: false,
      edit: false,
      patch: false,
      list: false,
      glob: false,
      grep: false,
      webfetch: false,
      task: false,
      todoread: false,
      todowrite: false,
      skill: false
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
      // routable address. Port is intentionally omitted: opencode's config
      // schema rejects an explicit `port: 0` (exclusiveMinimum 0), yet its
      // internal default already is 0 = OS-assigned an ephemeral port, which
      // is exactly what we want. Writing `port: 0` here makes opencode reject
      // the whole config and exit before the TUI starts. The MCP bridge has
      // its own localhost port — this is the opencode control server the TUI
      // talks to.
      hostname: '127.0.0.1'
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
    env: {
      // OPENCODE_CONFIG points opencode at the per-session config file we just
      // wrote (rather than relying on project-file discovery, which walks up to
      // the nearest git root and could pick up a real project config).
      OPENCODE_CONFIG: join(cwd, 'opencode.json'),
      // XDG_CONFIG_HOME relocates opencode's *global* config lookup to the empty
      // per-session dir, so the operator's `~/.config/opencode` — crucially its
      // mcp servers and plugins — is never merged into the bridged session. The
      // data dir (auth) is governed by XDG_DATA_HOME, which we leave alone, so
      // authed providers keep working.
      XDG_CONFIG_HOME: configHome
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
