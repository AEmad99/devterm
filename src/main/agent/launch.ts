import { execFile } from 'child_process'
import { createHash } from 'crypto'
import { promisify } from 'util'
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'fs'
import { homedir, tmpdir } from 'os'
import { dirname, join, sep } from 'path'
import type { BridgeInfo } from '../mcp/server'
import type {
  AgentCapabilities,
  AgentPreferences,
  AgentProviderStatus,
  SSHProfile
} from '@shared/types'
import { buildAgentsMd } from './context'
import { PI_EXTENSION_SOURCE } from './extension'

/** Extra spawn behavior. Remote launches omit this (temp cwd, MCP host tools). */
export interface AgentLaunchExtras {
  /** Enable the CLI's own fs/shell tools and run in `spawnCwd`. */
  nativeLocal?: boolean
  /** Operator directory for the agent process. Overlay temp still holds MCP config. */
  spawnCwd?: string
  /** Appended to the system prompt without planting AGENTS.md in the project. */
  appendSystemPrompt?: string
}

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
  const fallback = join(
    process.cwd(),
    'node_modules',
    '@earendil-works',
    'pi-coding-agent',
    'dist',
    'cli.js'
  )
  if (
    existsSync(fallback) ||
    process.env.NODE_ENV === 'test' ||
    process.execPath.includes('node')
  ) {
    return fallback
  }
  throw new Error('Bundled DevTerm Agent runtime is missing from the application package.')
}

/**
 * Resolve the platform-specific Node executable packaged with DevTerm.
 *
 * Throws when the bundled runtime is missing instead of silently falling back
 * to `process.execPath` (electron.exe / DevTerm.exe): running the pi CLI under
 * Electron produces no output and never exits, so the agent looks "stuck on
 * starting" forever. `npm run setup` installs the binary (the `node` npm
 * package's own preinstall script is skipped by `--ignore-scripts` installs);
 * packaged builds ship it via electron-builder's asarUnpack.
 */
export function resolveBundledNodeBin(): string {
  if (!process.versions.electron && process.execPath && existsSync(process.execPath)) {
    return process.execPath
  }
  const roots = require.resolve.paths('node') ?? []
  for (const root of roots) {
    for (const name of process.platform === 'win32' ? ['node.exe', 'node'] : ['node', 'node.exe']) {
      const bin = join(root, 'node', 'bin', name)
      if (existsSync(bin)) return externalNodePath(bin)
    }
  }
  throw new Error(
    'Bundled Node runtime for the DevTerm Agent is missing. Run `npm run setup` (or reinstall the app) to install it.'
  )
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

interface BuiltinLaunchOptions extends AgentLaunchExtras {
  preferences?: AgentPreferences
  sessionDir?: string
  sessionId?: string
  /** Passed as the trailing CLI message so interactive `pi "…"` starts working. */
  initialPrompt?: string
  /**
   * Write AGENTS.md into the overlay temp dir (remote default). Local native
   * launches skip this so the project's own AGENTS.md is what Pi loads.
   */
  writeContextFile?: boolean
  /** Skip Pi's project-trust prompt (`--approve`). Used for native local. */
  approveProject?: boolean
  /** Absolute path passed to `--append-system-prompt` (file, not inline text). */
  appendSystemPromptPath?: string
}

function isolatedAgentArgs(
  extensionPath: string | undefined,
  options?: BuiltinLaunchOptions
): string[] {
  const args: string[] = []
  if (!options?.nativeLocal) {
    // Remote: disable local read/write/bash so host work goes through MCP.
    // Native local keeps the CLI's own tools.
    args.push('--no-builtin-tools')
  }
  args.push(
    // Do not auto-load user executable extensions. The one explicit DevTerm
    // MCP extension remains loaded via `-e` when present.
    '--no-extensions',
    '--no-skills',
    '--no-prompt-templates',
    '--no-themes'
  )
  if (extensionPath) {
    args.push('-e', extensionPath)
  }
  args.push('--offline')
  if (options?.approveProject) args.push('--approve')
  if (options?.appendSystemPromptPath) {
    args.push('--append-system-prompt', options.appendSystemPromptPath)
  }
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
  const prompt = options?.initialPrompt?.replace(/\s+$/u, '')
  if (prompt) args.push(prompt)
  return args
}

function prepareAgentFiles(
  hostContextMd: string | undefined,
  withExtension: boolean
): {
  overlayDir: string
  extensionPath: string | undefined
  cleanup: () => void
} {
  const overlayDir = mkdtempSync(join(tmpdir(), 'devterm-agent-'))
  if (hostContextMd !== undefined) {
    writeFileSync(join(overlayDir, 'AGENTS.md'), hostContextMd, { mode: 0o600 })
  }
  let extensionPath: string | undefined
  if (withExtension) {
    extensionPath = join(overlayDir, 'devterm-mcp.mjs')
    writeFileSync(extensionPath, PI_EXTENSION_SOURCE, { mode: 0o600 })
  }
  return {
    overlayDir,
    extensionPath,
    cleanup: () => {
      try {
        rmSync(overlayDir, { recursive: true, force: true })
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
  return finishPiLaunch(resolveBundledNodeBin(), true, hostContextMd, bridge, options)
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
  const [versionResult, models] = await Promise.all([
    execFileAsync(bin, [cli, '--version'], { encoding: 'utf8', timeout: 30_000 }),
    discoverOfflineCatalog(bin)
  ])
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

/** One row of the offline model catalog (shape mirrors `AgentModelInfo`). */
interface OfflineModelRow {
  provider: string
  model: string
  context: string
  maxOutput: string
  thinking: boolean
  images: boolean
}

/**
 * Where pi's *static* built-in catalog lives. pi's `--list-models` only lists
 * models of providers with configured credentials ("No models available" on a
 * fresh machine), but the generated catalog shipped inside
 * `@earendil-works/pi-ai` (nested under the pi package) is credential-blind —
 * exactly the offline catalog the Settings page needs.
 */
function resolvePiAiCatalogDir(): string | undefined {
  try {
    const piRoot = dirname(dirname(resolveBundledAgentCli()))
    const candidate = join(
      piRoot,
      'node_modules',
      '@earendil-works',
      'pi-ai',
      'dist',
      'models.generated.js'
    )
    return existsSync(candidate) ? dirname(candidate) : undefined
  } catch {
    return undefined
  }
}

/**
 * Dump the full offline catalog by running a tiny ESM probe with the bundled
 * Node runtime (pi-ai is ESM-only, so it cannot be require()d from the CJS
 * main bundle). Falls back to parsing the CLI's `--list-models` table (which
 * only lists authenticated providers) when the catalog module is unavailable.
 */
async function discoverOfflineCatalog(bin: string): Promise<OfflineModelRow[]> {
  const catalogDir = resolvePiAiCatalogDir()
  if (catalogDir) {
    const probeDir = mkdtempSync(join(tmpdir(), 'devterm-catalog-'))
    const probePath = join(probeDir, 'catalog-probe.mjs')
    writeFileSync(
      probePath,
      [
        "import { pathToFileURL } from 'node:url'",
        "const dist = process.env.DEVTERM_PI_AI_DIST",
        "if (!dist) { console.log('[]'); process.exit(0) }",
        "const mod = await import(pathToFileURL(dist + '/models.generated.js').href)",
        'const rows = []',
        'for (const [provider, models] of Object.entries(mod.MODELS || {})) {',
        '  if (!models || typeof models !== \'object\') continue',
        "  for (const [model, def] of Object.entries(models)) {",
        "    if (!def || typeof def !== 'object') continue",
        '    rows.push({',
        '      provider,',
        '      model,',
        "      context: String(def.contextWindow ?? ''),",
        "      maxOutput: String(def.maxTokens ?? ''),",
        '      thinking: def.reasoning === true,',
        "      images: Array.isArray(def.input) && def.input.includes('image')",
        '    })',
        '  }',
        '}',
        'console.log(JSON.stringify(rows))'
      ].join('\n')
    )
    try {
      const { stdout } = await execFileAsync(bin, [probePath], {
        encoding: 'utf8',
        timeout: 30_000,
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, DEVTERM_PI_AI_DIST: catalogDir }
      })
      const rows = JSON.parse(stdout.trim())
      if (Array.isArray(rows) && rows.length > 0) return rows as OfflineModelRow[]
    } catch {
      /* probe failed — fall through to the CLI table below */
    } finally {
      rmSync(probeDir, { recursive: true, force: true })
    }
  }

  // Legacy path: parse the CLI's `--list-models` table (auth-filtered).
  const cli = resolveBundledAgentCli()
  const modelsResult = await execFileAsync(bin, [cli, '--offline', '--list-models'], {
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 32 * 1024 * 1024
  })
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
  return models
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
  bridge: BridgeInfo,
  options?: BuiltinLaunchOptions
): Promise<AgentLaunchSpec> {
  return finishPiLaunch(await resolvePiBin(), false, hostContextMd, bridge, options)
}

async function finishPiLaunch(
  bin: string,
  bundledCli: boolean,
  hostContextMd: string,
  bridge: BridgeInfo,
  options?: BuiltinLaunchOptions
): Promise<AgentLaunchSpec> {
  const writeContext = options?.writeContextFile !== false && !options?.nativeLocal
  const files = prepareAgentFiles(writeContext ? hostContextMd : undefined, true)
  let appendPath = options?.appendSystemPromptPath
  if (!appendPath && options?.appendSystemPrompt) {
    appendPath = join(files.overlayDir, 'devterm-append-prompt.md')
    writeFileSync(appendPath, options.appendSystemPrompt, { mode: 0o600 })
  }
  const args = isolatedAgentArgs(files.extensionPath, {
    ...options,
    appendSystemPromptPath: appendPath
  })
  return {
    bin,
    args: bundledCli ? [resolveBundledAgentCli(), ...args] : args,
    cwd: options?.spawnCwd || files.overlayDir,
    env: {
      DEVTERM_BRIDGE_URL: bridge.url,
      DEVTERM_BRIDGE_TOKEN: bridge.token,
      DEVTERM_MCP_DIR: files.overlayDir,
      ...(bundledCli
        ? { DEVTERM_MODEL_FALLBACKS: JSON.stringify(options?.preferences?.fallbackModels ?? []) }
        : {})
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
      if (!/^devterm-(agent|pi|claude|kimi|opencode|grok|codex|antigravity)-/.test(entry)) continue
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

/**
 * Derive a stable, persistent session ID for remote agent conversations so
 * sessions persist per connection profile or host identity across tab opens
 * and app restarts.
 */
export function deriveAgentSessionId(sessionId: string, profile?: SSHProfile): string {
  if (profile?.id) {
    return `remote-${profile.id.replace(/[^a-zA-Z0-9_-]/g, '-')}`
  }
  if (profile?.host && profile?.username) {
    const key = `${profile.username}@${profile.host}:${profile.port || 22}`
    return `remote-${key.replace(/[^a-zA-Z0-9_-]/g, '-')}`
  }
  return sessionId.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 128)
}

/** Directory the native local agent process should run in (operator cwd, else home). */
export function resolveLocalSpawnCwd(cwd?: string): string {
  const candidate = cwd?.trim()
  if (candidate) {
    try {
      if (statSync(candidate).isDirectory()) return candidate
    } catch {
      /* fall through */
    }
  }
  return homedir()
}

/**
 * Stable per-directory resume key for local agents so two folders do not share
 * one transcript (the old hard-coded `'local'` id did).
 */
export function deriveLocalAgentSessionId(cwd?: string): string {
  const raw = (cwd ?? '').trim()
  if (!raw) return 'local'
  const normalized = raw.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const digest = createHash('sha256').update(normalized).digest('hex').slice(0, 16)
  return `local-${digest}`
}
