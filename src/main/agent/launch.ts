import { execFile } from 'child_process'
import { createHash } from 'crypto'
import { promisify } from 'util'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join, sep } from 'path'
import type { BridgeInfo } from '../mcp/server'
import type { AgentCapabilities, AgentPreferences, AgentProviderStatus } from '@shared/types'
import { buildAgentsMd } from './context'
import { PI_EXTENSION_SOURCE } from './extension'

const execFileAsync = promisify(execFile)
const binCache = new Map<string, string>()

async function resolveOnWindows(name: string): Promise<string | undefined> {
  // npm creates a bare `pi` shim next to a `pi.cmd` shim for global packages
  // on Windows. The bare shim is often a POSIX shell script (intended for
  // git-bash / MSYS / WSL); CreateProcessW can't run it, which surfaces as
  // error 193 (ERROR_BAD_EXE_FORMAT) from node-pty. The `.cmd` / `.bat` /
  // `.exe` shim is a real Windows batch/PE file that resolves the same
  // entry point via node, so prefer those. Fall back to the first match only
  // if no Windows shim exists; if the install only has the POSIX shim the user
  // will see a clear error 193 and can fix it.
  try {
    const { stdout } = await execFileAsync('where', [name], { encoding: 'utf8' })
    const out = stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
    const winShim = out.find(
      (p) =>
        p.toLowerCase().endsWith('.cmd') ||
        p.toLowerCase().endsWith('.bat') ||
        p.toLowerCase().endsWith('.exe')
    )
    return winShim || out[0]
  } catch {
    return undefined
  }
}

async function resolveOnPosix(name: string): Promise<string | undefined> {
  // `command` is a shell builtin — execFile('command', ...) always throws
  // (ENOENT), so resolution used to fall through to the bare-name fallback
  // every time. Run it through `sh` instead.
  try {
    const { stdout } = await execFileAsync('sh', ['-c', 'command -v "$1"', 'sh', name], {
      encoding: 'utf8'
    })
    const out = stdout.split(/\r?\n/).find((l) => l.trim())
    return out?.trim()
  } catch {
    return undefined
  }
}

export async function resolveCached(
  name: string,
  winFallback: string,
  posixFallback: string
): Promise<string> {
  const cached = binCache.get(name)
  if (cached) return cached
  const resolved =
    process.platform === 'win32' ? await resolveOnWindows(name) : await resolveOnPosix(name)
  // Only cache a genuinely resolved path. Caching the bare-name fallback
  // meant a CLI installed later wasn't found until an app restart.
  if (resolved) {
    binCache.set(name, resolved)
    return resolved
  }
  return process.platform === 'win32' ? winFallback : posixFallback
}

/** Resolve the interactive `pi` binary on PATH. Falls back to the bare name. */
export async function resolvePiBin(): Promise<string> {
  return resolveCached('pi', 'pi.cmd', 'pi')
}

/**
 * Resolve the CLI shipped inside the application. Resolve the public package
 * entry first (the package export map intentionally hides package.json), then
 * step sideways to the sibling cli.js file.
 */
export function resolveBundledAgentCli(): string {
  // The package intentionally exposes ESM imports only, so require.resolve()
  // of the package name is rejected by its export map in our CommonJS main
  // bundle. Search Node's resolved module roots for the known package asset
  // instead. Electron's fs patches make the same existsSync check ASAR-aware.
  const roots = require.resolve.paths('@earendil-works/pi-coding-agent') ?? []
  for (const root of roots) {
    const cli = join(root, '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js')
    if (existsSync(cli)) return externalNodePath(cli)
  }
  throw new Error('Bundled DevTerm Agent runtime is missing from the application package.')
}

/** Resolve the platform-specific Node executable packaged with DevTerm. */
export function resolveBundledNodeBin(): string {
  const roots = require.resolve.paths('node') ?? []
  for (const root of roots) {
    for (const name of process.platform === 'win32' ? ['node.exe', 'node'] : ['node', 'node.exe']) {
      const bin = join(root, 'node', 'bin', name)
      if (existsSync(bin)) return externalNodePath(bin)
    }
  }
  throw new Error('Bundled Node runtime for DevTerm Agent is missing from the application package.')
}

/** External Node cannot read Electron's virtual app.asar filesystem. */
function externalNodePath(path: string): string {
  const marker = `${sep}app.asar${sep}`
  if (!path.includes(marker)) return path
  const unpacked = path.replace(marker, `${sep}app.asar.unpacked${sep}`)
  return existsSync(unpacked) ? unpacked : path
}

export interface AgentLaunchSpec {
  bin: string
  args: string[]
  cwd: string
  env: Record<string, string>
  cleanup: () => void
}

interface BuiltinLaunchOptions {
  preferences?: AgentPreferences
  sessionDir?: string
  sessionId?: string
}

function isolatedAgentArgs(extensionPath: string, options?: BuiltinLaunchOptions): string[] {
  const args = [
    // Disable local read/write/bash tools while preserving the explicitly
    // loaded DevTerm MCP extension. The bundled runtime pins a release that
    // supports this distinction; external Pi is a fallback and must be current.
    '--no-builtin-tools',
    // Do not auto-load user code or project resources into the privileged
    // local agent process. The one explicit DevTerm extension remains loaded.
    '--no-extensions',
    '--no-skills',
    '--no-prompt-templates',
    '--no-themes',
    '-e',
    extensionPath,
    '--offline'
  ]
  const preferences = options?.preferences
  if (preferences?.resumeSessions && options?.sessionDir && options.sessionId) {
    args.push('--session-dir', options.sessionDir, '--session-id', options.sessionId)
  } else {
    args.unshift('--no-session')
  }
  if (preferences?.provider.trim()) args.push('--provider', preferences.provider.trim())
  if (preferences?.model.trim()) args.push('--model', preferences.model.trim())
  const modelCycle = [preferences?.model, ...(preferences?.fallbackModels ?? [])]
    .map((value) => value?.trim() ?? '')
    .filter(Boolean)
  if (modelCycle.length > 1) args.push('--models', [...new Set(modelCycle)].join(','))
  for (const skill of preferences?.trustedSkills ?? []) {
    if (!skill.enabled) continue
    try {
      const stat = statSync(skill.path)
      if (!stat.isFile() || stat.size > 512 * 1024) continue
      const digest = createHash('sha256').update(readFileSync(skill.path)).digest('hex')
      if (digest !== skill.sha256.toLowerCase()) continue
      args.push('--skill', skill.path)
    } catch {
      /* Missing or modified skills remain disabled until explicitly re-approved. */
    }
  }
  return args
}

function prepareAgentFiles(hostContextMd: string): {
  cwd: string
  extensionPath: string
  cleanup: () => void
} {
  const cwd = mkdtempSync(join(tmpdir(), 'devterm-agent-'))
  writeFileSync(join(cwd, 'AGENTS.md'), hostContextMd, { mode: 0o600 })
  const extensionPath = join(cwd, 'devterm-mcp.mjs')
  writeFileSync(extensionPath, PI_EXTENSION_SOURCE, { mode: 0o600 })
  return {
    cwd,
    extensionPath,
    cleanup: () => {
      try {
        rmSync(cwd, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Launch DevTerm's embedded provider-agnostic agent implementation. The agent
 * package and its dedicated compatible Node runtime are both part of the app. Model
 * credentials stay in Pi's own auth store/environment and support both OAuth
 * subscriptions and API keys without ever crossing DevTerm IPC.
 */
export async function prepareBuiltinAgentLaunch(
  hostContextMd: string,
  bridge: BridgeInfo,
  options?: BuiltinLaunchOptions
): Promise<AgentLaunchSpec> {
  const files = prepareAgentFiles(hostContextMd)
  return {
    bin: resolveBundledNodeBin(),
    args: [resolveBundledAgentCli(), ...isolatedAgentArgs(files.extensionPath, options)],
    cwd: files.cwd,
    env: {
      DEVTERM_BRIDGE_URL: bridge.url,
      DEVTERM_BRIDGE_TOKEN: bridge.token,
      DEVTERM_MODEL_FALLBACKS: JSON.stringify(options?.preferences?.fallbackModels ?? [])
    },
    cleanup: files.cleanup
  }
}

let capabilitiesCache: AgentCapabilities | undefined

const PROVIDER_ENV: Record<string, string[]> = {
  anthropic: ['ANTHROPIC_API_KEY', 'ANTHROPIC_OAUTH_TOKEN'],
  openai: ['OPENAI_API_KEY'],
  'azure-openai': ['AZURE_OPENAI_API_KEY'],
  google: ['GEMINI_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
  groq: ['GROQ_API_KEY'],
  cerebras: ['CEREBRAS_API_KEY'],
  xai: ['XAI_API_KEY'],
  fireworks: ['FIREWORKS_API_KEY'],
  together: ['TOGETHER_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  mistral: ['MISTRAL_API_KEY'],
  minimax: ['MINIMAX_API_KEY'],
  moonshot: ['MOONSHOT_API_KEY'],
  opencode: ['OPENCODE_API_KEY'],
  kimi: ['KIMI_API_KEY'],
  bedrock: ['AWS_PROFILE', 'AWS_ACCESS_KEY_ID', 'AWS_BEARER_TOKEN_BEDROCK']
}

function readProviderAuth(): Map<string, AgentProviderStatus['source']> {
  const found = new Map<string, AgentProviderStatus['source']>()
  for (const [provider, names] of Object.entries(PROVIDER_ENV)) {
    if (names.some((name) => Boolean(process.env[name]))) found.set(provider, 'environment')
  }
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent')
  try {
    const parsed = JSON.parse(readFileSync(join(agentDir, 'auth.json'), 'utf8')) as Record<
      string,
      unknown
    >
    for (const [provider, value] of Object.entries(parsed)) {
      const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
      found.set(provider, record.type === 'oauth' ? 'oauth' : 'api-key')
    }
  } catch {
    /* No auth store yet. The UI will direct the user to /login. */
  }
  return found
}

/** Discover the bundled runtime's model catalog without exposing credentials. */
export async function getBuiltinAgentCapabilities(
  forceRefresh = false
): Promise<AgentCapabilities> {
  if (!forceRefresh && capabilitiesCache && Date.now() - capabilitiesCache.loadedAt < 300_000) {
    return capabilitiesCache
  }
  const bin = resolveBundledNodeBin()
  const cli = resolveBundledAgentCli()
  const [versionResult, modelsResult] = await Promise.all([
    execFileAsync(bin, [cli, '--version'], { encoding: 'utf8', timeout: 15_000 }),
    execFileAsync(bin, [cli, '--offline', '--list-models'], {
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 32 * 1024 * 1024
    })
  ])
  const lines = modelsResult.stdout.split(/\r?\n/).slice(1)
  const models = lines.flatMap((line) => {
    const fields = line.trim().split(/\s{2,}/)
    if (fields.length < 6) return []
    return [
      {
        provider: fields[0],
        model: fields[1],
        context: fields[2],
        maxOutput: fields[3],
        thinking: fields[4] === 'yes',
        images: fields[5] === 'yes'
      }
    ]
  })
  const auth = readProviderAuth()
  const providerIds = new Set(models.map((model) => model.provider))
  for (const provider of auth.keys()) providerIds.add(provider)
  const providers = [...providerIds]
    .sort((a, b) => a.localeCompare(b))
    .map((provider) => ({
      provider,
      authenticated: auth.has(provider),
      ...(auth.has(provider) ? { source: auth.get(provider) } : {})
    }))
  capabilitiesCache = {
    runtimeVersion: versionResult.stdout.trim(),
    models,
    providers,
    loadedAt: Date.now()
  }
  return capabilitiesCache
}

/**
 * Prepare a per-session working directory containing an AGENTS.md (the host
 * briefing pi auto-loads) and a pi extension that bridges pi's tool system to
 * our in-process MCP server, and return the spawn spec for interactive `pi`.
 *
 * The extension is loaded with `-e <absolute-path>`. Bridge URL + bearer
 * token travel through env vars (`DEVTERM_BRIDGE_URL`, `DEVTERM_BRIDGE_TOKEN`)
 * rather than being serialised into the file on disk.
 */
export async function prepareAgentLaunch(
  hostContextMd: string,
  bridge: BridgeInfo
): Promise<AgentLaunchSpec> {
  const files = prepareAgentFiles(hostContextMd)

  return {
    bin: await resolvePiBin(),
    args: isolatedAgentArgs(files.extensionPath),
    cwd: files.cwd,
    env: {
      DEVTERM_BRIDGE_URL: bridge.url,
      DEVTERM_BRIDGE_TOKEN: bridge.token
    },
    cleanup: files.cleanup
  }
}

export { buildAgentsMd }

/**
 * Remove per-session agent temp dirs (`devterm-<kind>-*`) left behind by a
 * crash or kill — they hold the bridge bearer token, and codex sessions copy
 * `~/.codex/auth.json` into them. Explicit close already cleans up; this is
 * the crash-path backstop, called once when the agent IPC module initializes.
 * Only dirs older than a day are touched so a concurrently running second
 * instance's live session is never swept.
 */
export function sweepStaleAgentTempDirs(maxAgeMs = 24 * 60 * 60 * 1000): void {
  try {
    for (const entry of readdirSync(tmpdir())) {
      if (!/^devterm-(agent|pi|claude|kimi|opencode|grok|codex)-/.test(entry)) continue
      const full = join(tmpdir(), entry)
      try {
        const stat = statSync(full)
        if (!stat.isDirectory() || Date.now() - stat.mtimeMs < maxAgeMs) continue
        rmSync(full, { recursive: true, force: true })
      } catch {
        /* ignore individual failures */
      }
    }
  } catch {
    /* tmpdir unreadable — nothing to sweep */
  }
}
