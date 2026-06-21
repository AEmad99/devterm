import { execSync } from 'child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
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
 * Names of every MCP server the operator has configured globally, so the
 * per-session config can switch each one off.
 *
 * opencode only ever *merges* config layers (a merge can't delete a key) and
 * has no "ignore global config" switch, so without this the operator's
 * `~/.config/opencode` mcp servers would be handed straight to the air-gapped
 * agent — on the dev box this file was written against that was five
 * `kubernetes-mcp-server` instances and an obsidian server, all `type: local`,
 * i.e. they spawn processes on *this* machine, which would defeat the
 * no-local-shell guarantee the bridge exists to enforce. Setting
 * `{ enabled: false }` for each name in our higher-precedence config wins the
 * merge conflict and stops opencode starting them.
 *
 * Best-effort: opencode resolves its global config from `$XDG_CONFIG_HOME/
 * opencode` (falling back to `~/.config/opencode`) and accepts `opencode.json`
 * or the legacy `config.json`. We read the raw file and return its `mcp` keys.
 * A missing or unparseable (e.g. JSONC) file yields `[]`; `--pure` still strips
 * the other capability vector — plugins — regardless of what we can read here.
 *
 * Note we deliberately do NOT relocate the config dir to isolate it: opencode
 * bootstraps a multi-package plugin runtime into the config dir on startup, so
 * pointing it at an empty per-session dir re-installs that runtime on every
 * launch (seconds of latency, and a hard failure with no registry access).
 * Keeping the real dir lets the operator's provider/model/auth and that runtime
 * load natively; we subtract capabilities instead of rebuilding from nothing.
 */
function operatorMcpServerNames(): string[] {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  const dir = join(base, 'opencode')
  for (const name of ['opencode.json', 'config.json']) {
    const file = join(dir, name)
    try {
      if (!existsSync(file)) continue
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { mcp?: Record<string, unknown> }
      return parsed.mcp ? Object.keys(parsed.mcp) : []
    } catch {
      /* unreadable / non-plain-JSON — try the next candidate */
    }
  }
  return []
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
 * Isolation from the operator's own opencode setup: we keep opencode's real
 * config dir (so their provider/model/auth and opencode's installed plugin
 * runtime all load natively) and subtract the capability vectors instead —
 * every operator MCP server is disabled by name (see
 * {@link operatorMcpServerNames}) and `--pure` drops external plugins. Net
 * effect: the agent inherits the operator's chosen model but none of their
 * host-reaching mcp servers or plugins, and can still only touch the host
 * through `devterm_*`.
 */
export function prepareOpencodeLaunch(hostContextMd: string, bridge: BridgeInfo): AgentLaunchSpec {
  const cwd = mkdtempSync(join(tmpdir(), 'devterm-opencode-'))
  writeFileSync(join(cwd, 'AGENTS.md'), hostContextMd, { mode: 0o600 })

  // Disable every MCP server the operator configured globally. Deep-merge: our
  // `enabled: false` wins the conflict on `mcp.<name>.enabled`, so opencode
  // resolves them as disabled and never starts them — including `type: local`
  // ones that would otherwise spawn processes on this machine.
  const disabledMcp: Record<string, { enabled: boolean }> = {}
  for (const name of operatorMcpServerNames()) {
    if (name !== 'devterm') disabledMcp[name] = { enabled: false }
  }

  const opencodeConfig = {
    $schema: 'https://opencode.ai/config.json',
    mcp: {
      // Operator servers off (spread first); our bridge on (last, so a stray
      // operator server literally named "devterm" can't shadow it).
      ...disabledMcp,
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
    // cwd). `--pure` (a global flag) runs without external plugins, so the
    // operator's configured plugins never load into the bridged session; the
    // operator's mcp servers are handled by the disable list in the config.
    args: ['--pure', cwd],
    cwd,
    env: {
      // OPENCODE_CONFIG points opencode at the per-session config file we just
      // wrote (rather than relying on project-file discovery, which walks up to
      // the nearest git root and could pick up a real project config). The
      // operator's real config dir still loads and merges underneath — that's
      // deliberate: it carries their provider/model/auth and opencode's
      // already-installed plugin runtime, so the session starts instantly and
      // works offline instead of re-installing packages on every launch. Our
      // config above wins every conflict (adds the bridge, disables their mcp
      // servers, scopes tools); `--pure` covers plugins.
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
