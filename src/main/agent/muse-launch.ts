import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { execSync } from 'child_process'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import type { BridgeInfo } from '../mcp/server'
import type { AgentEffort } from '@shared/types'
import type { AgentLaunchExtras, AgentLaunchSpec } from './launch'
import { resolveCached } from './launch'
import { buildMuseMd } from './context'

/**
 * Muse supports none|minimal|low|medium|high|xhigh|max|ultra. DevTerm's
 * provider-neutral max maps directly to Muse's max tier.
 */
export function museReasoningEffort(value: unknown): AgentEffort | undefined {
  return value === 'low' || value === 'medium' || value === 'high' || value === 'max'
    ? value
    : undefined
}

/**
 * Keep initial prompts below the Windows command-line budget. Larger prompts
 * are delivered by the renderer's PTY injection fallback.
 */
export const MUSE_PROMPT_ARG_LIMIT = 12000

/**
 * Resolve Meta's interactive Muse Code launcher.
 *
 * The Windows installer used on this machine is a per-user launcher at
 * `%LOCALAPPDATA%\\Programs\\muse\\muse.cmd`; it is not registered in App Paths.
 * PATH resolution remains the fallback for custom installs and non-Windows
 * environments.
 */
export async function resolveMuseBin(): Promise<string> {
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA
    if (localAppData) {
      for (const name of ['muse.cmd', 'muse.exe']) {
        const installed = join(localAppData, 'Programs', 'muse', name)
        if (existsSync(installed)) return installed
      }
    }

    try {
      const out = execSync('where muse', { encoding: 'utf8' })
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
      const winShim = out.find(
        (path) =>
          path.toLowerCase().endsWith('.cmd') ||
          path.toLowerCase().endsWith('.bat') ||
          path.toLowerCase().endsWith('.exe')
      )
      if (winShim) return winShim
      if (out[0]) return out[0]
    } catch {
      /* Muse is not on PATH; use the standard Windows fallback below. */
    }
    return resolveCached('muse', 'muse.cmd', 'muse')
  }

  return resolveCached('muse', 'muse.cmd', 'muse')
}

function copyMuseAuth(destConfigHome: string): string | undefined {
  const sourceConfigHomes = [
    process.env.XDG_CONFIG_HOME?.trim(),
    join(homedir(), '.config'),
    process.env.APPDATA?.trim()
  ].filter((path): path is string => Boolean(path))

  const source = sourceConfigHomes
    .map((configHome) => join(configHome, 'muse', 'auth.json'))
    .find((path) => existsSync(path))
  if (!source) return undefined

  const dest = join(destConfigHome, 'muse', 'auth.json')
  try {
    mkdirSync(join(destConfigHome, 'muse'), { recursive: true })
    copyFileSync(source, dest)
    return dest
  } catch {
    // Muse can still authenticate interactively in the visible pane.
    return undefined
  }
}

function museSettings(bridge: BridgeInfo): string {
  return JSON.stringify(
    {
      schema_version: 1,
      provider: 'meta',
      mcp_servers: {
        devterm: {
          transport: 'streamable_http',
          url: bridge.url,
          headers: {
            Authorization: `Bearer ${bridge.token}`
          },
          enabled: true,
          mode: 'required'
        }
      }
    },
    null,
    2
  )
}

function configuredMuseModel(extras?: AgentLaunchExtras): string | undefined {
  const explicit = extras?.model?.trim()
  if (explicit) return normalizeMuseModel(explicit)

  const provider = extras?.preferences?.provider.trim().toLowerCase()
  const configured = extras?.preferences?.model.trim()
  // The shared DevTerm model field can contain another provider's model. Only
  // carry it into Muse when the persisted provider is automatic or Meta.
  return configured && (!provider || provider === 'meta')
    ? normalizeMuseModel(configured)
    : undefined
}

function normalizeMuseModel(value: string): string {
  return value.toLowerCase().startsWith('meta/') ? value.slice('meta/'.length) : value
}

/**
 * Prepare an isolated Muse Code configuration with the DevTerm MCP bridge.
 *
 * The config home is temporary so global Muse MCP servers and permission
 * profiles cannot leak into a DevTerm session. The operator's Muse auth file
 * is copied when available, never moved or modified. `--yolo` disables Muse's
 * own approval/sandbox layer as requested; DevTerm's MCP approval rules remain
 * enforced by the bridge before any host tool runs.
 *
 * Remote sessions additionally disable Muse's native shell and workspace
 * writes. Host work therefore goes through the DevTerm MCP bridge. Local
 * sessions keep Muse's native tools in the operator's folder and use MCP for
 * browser and local-agent handoff.
 */
export async function prepareMuseLaunch(
  hostContextMd: string,
  bridge: BridgeInfo,
  extras?: AgentLaunchExtras
): Promise<AgentLaunchSpec> {
  const overlay = mkdtempSync(join(tmpdir(), 'devterm-muse-'))
  const configHome = join(overlay, 'config')
  const museConfigDir = join(configHome, 'muse')
  mkdirSync(museConfigDir, { recursive: true })

  if (!extras?.nativeLocal) {
    writeFileSync(join(overlay, 'AGENTS.md'), hostContextMd, { mode: 0o600 })
  }
  writeFileSync(join(museConfigDir, 'settings.json'), museSettings(bridge), { mode: 0o600 })
  const authPath = copyMuseAuth(configHome)

  const args = ['--yolo']
  if (!extras?.nativeLocal) {
    // Host files and commands are exposed through DevTerm's MCP backend.
    args.push('--disable-shell', '--disable-write')
  }
  const model = configuredMuseModel(extras)
  if (model) args.push('--model', model)
  const effort = museReasoningEffort(extras?.effort)
  if (effort) args.push('--reasoning-effort', effort)

  const prompt = extras?.initialPrompt?.replace(/\s+$/u, '')
  let promptDelivered = false
  if (prompt && prompt.length <= MUSE_PROMPT_ARG_LIMIT) {
    // Muse treats a positional prompt as the first message of its interactive
    // TUI. `muse exec` is intentionally not used here.
    args.push(prompt)
    promptDelivered = true
  }

  return {
    bin: await resolveMuseBin(),
    args,
    cwd: extras?.spawnCwd || overlay,
    env: {
      // Avoid the installer's background update process while its launcher is
      // running inside a session-owned temporary directory.
      MUSE_NO_AUTO_UPDATE: '1',
      XDG_CONFIG_HOME: configHome,
      ...(authPath ? { MUSE_AUTH_PATH: authPath } : {})
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

export { buildMuseMd }
