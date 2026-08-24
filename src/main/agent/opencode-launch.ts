import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { BridgeInfo } from '../mcp/server'
import { resolveCached } from './launch'
import type { AgentLaunchExtras, AgentLaunchSpec } from './launch'
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
export async function resolveOpencodeBin(): Promise<string> {
  return resolveCached('opencode', 'opencode.cmd', 'opencode')
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
 * noise) and share/upload defaults; the control server defaults keep it on
 * localhost with an OS-assigned port.
 */
export async function prepareOpencodeLaunch(
  hostContextMd: string,
  bridge: BridgeInfo,
  extras?: AgentLaunchExtras
): Promise<AgentLaunchSpec> {
  const overlay = mkdtempSync(join(tmpdir(), 'devterm-opencode-'))
  if (!extras?.nativeLocal) {
    writeFileSync(join(overlay, 'AGENTS.md'), hostContextMd, { mode: 0o600 })
  }

  const native = extras?.nativeLocal === true
  const opencodeConfig: Record<string, unknown> = {
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
    // The bridge is a short-lived localhost HTTP endpoint. autoupdate
    // would interrupt the session with a download prompt; sharing would try
    // to upload session JSON to opencode.ai and break the air-gapped rule;
    // snapshot is local-only but adds startup indexing cost we don't need.
    autoupdate: false,
    share: 'disabled',
    snapshot: false
    // We intentionally omit the `server` block: the defaults already bind the
    // opencode control server to 127.0.0.1 with an OS-assigned port, and the
    // opencode config schema rejects an explicit port of 0.
  }
  if (!native) {
    // Remote: scope the agent to MCP tools only. OpenCode ships these built-in
    // tools (https://opencode.ai/docs/tools/) — turning every one off means
    // every host action has to go through `devterm_*` on this SSH session.
    opencodeConfig.tools = {
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
    }
  } else if (extras?.appendSystemPrompt) {
    opencodeConfig.instructions = extras.appendSystemPrompt
  }
  writeFileSync(join(overlay, 'opencode.json'), JSON.stringify(opencodeConfig, null, 2), {
    mode: 0o600
  })

  const project = extras?.spawnCwd || overlay
  return {
    bin: await resolveOpencodeBin(),
    // `opencode [project]` is the default command — when no subcommand is
    // given, opencode starts the TUI against the project at `[project]` (or
    // cwd). MCP config is always the overlay file via OPENCODE_CONFIG.
    args: [project],
    cwd: project,
    env: {
      OPENCODE_CONFIG: join(overlay, 'opencode.json')
    },
    cleanup: () => {
      try {
        rmSync(overlay, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
  }
}

export { buildOpencodeMd }
