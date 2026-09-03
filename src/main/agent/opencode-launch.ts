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
 * CLI-arg budget for the handoff prompt. Windows CreateProcess caps the whole
 * command line at 32767 chars; stay far below it so delegated tasks with long
 * plans still spawn. Oversized prompts are omitted here and delivered by the
 * renderer's PTY injection fallback instead (see `promptDelivered`).
 */
export const OPENCODE_PROMPT_ARG_LIMIT = 12000

/**
 * Prepare a per-session working directory containing an `opencode.json` that
 * wires the in-process MCP bridge as a remote server, and return the spawn
 * spec for interactive `opencode` scoped to the bridge tools.
 *
 * The TUI stays interactive: `opencode [project] --prompt "..."` opens the
 * TUI with the prompt pre-filled (only `opencode run` is non-interactive), so
 * the handoff task travels as a CLI argument — never `--prompt`-less PTY
 * typing. `--model` takes `provider/model`.
 *
 * OpenCode ships these built-in tools (https://opencode.ai/docs/tools/) — turning every one off means
 * every host action has to go through `devterm_*` on this SSH session.
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
    // `instructions` is a string ARRAY in opencode's schema — a bare string
    // fails config validation ("Expected array | undefined") and the TUI
    // exits immediately. One entry = one appended system-prompt document.
    opencodeConfig.instructions = [extras.appendSystemPrompt]
  }
  writeFileSync(join(overlay, 'opencode.json'), JSON.stringify(opencodeConfig, null, 2), {
    mode: 0o600
  })

  const project = extras?.spawnCwd || overlay
  // `opencode [project]` is the default command — when no subcommand is
  // given, opencode starts the TUI against the project at `[project]` (or
  // cwd). MCP config is always the overlay file via OPENCODE_CONFIG.
  // `--prompt` pre-fills the TUI input (it does NOT switch to non-interactive
  // `run` mode); `-m` selects `provider/model` for this session only.
  const args = [project]
  const model = extras?.model?.trim()
  if (model) args.push('--model', model)
  const prompt = extras?.initialPrompt?.replace(/\s+$/u, '')
  let promptDelivered = false
  if (prompt) {
    if (prompt.length <= OPENCODE_PROMPT_ARG_LIMIT) {
      args.push('--prompt', prompt)
      promptDelivered = true
    }
    // Oversized prompts stay out of argv (CreateProcess command-line cap) and
    // are typed into the TUI by the renderer's PTY injection fallback.
  }
  return {
    bin: await resolveOpencodeBin(),
    args,
    cwd: project,
    env: {
      OPENCODE_CONFIG: join(overlay, 'opencode.json')
    },
    promptDelivered,
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
