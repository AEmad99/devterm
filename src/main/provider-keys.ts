import { app, safeStorage } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'

/**
 * Provider API key store.
 *
 * Each provider has a stable string id (`'openai'`, `'anthropic'`, …) and a
 * corresponding well-known env-var name the agent CLI consumes
 * (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, …). The renderer never sees the
 * plaintext — IPC returns only `{ id, isSet }` for the listing and accepts
 * set/clear calls. The plaintext is read back out of main only at agent
 * launch time, where it is folded into the spec env (see
 * `src/main/agent/{launch,claude-launch,opencode-launch}.ts`).
 *
 * Encryption mirrors `src/main/ipc/connections.ts:20-39` exactly: safeStorage
 * ciphertext is base64-encoded with a `v1:` sentinel; on hosts without a
 * keychain (rare; safeStorage.isEncryptionAvailable() === false) the secret is
 * stored as `raw:<plain>` so the user isn't locked out — they just lose at-rest
 * encryption. A corrupt or unknown prefix drops the secret (the connection
 * stays; the key is simply unset).
 */

const ENC = 'v1:'
const RAW = 'raw:'

/** Provider id + matching env-var name consumed by the agent CLIs. */
export interface ProviderSpec {
  id: 'openai' | 'anthropic' | 'openrouter' | 'gemini' | 'azure'
  /** Display name for the Settings UI. */
  label: string
  /** Env-var name set on the agent PTY when this provider's key is configured. */
  envVar: string
  /** Short blurb shown next to the field. */
  hint: string
}

/** The providers DevTerm knows how to inject. Order = display order. */
export const PROVIDERS: readonly ProviderSpec[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    envVar: 'OPENAI_API_KEY',
    hint: 'Used by codex/opencode against api.openai.com.'
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    envVar: 'ANTHROPIC_API_KEY',
    hint: 'Used by the Claude CLI and any Anthropic-backed provider.'
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    envVar: 'OPENROUTER_API_KEY',
    hint: 'Used by opencode / pi when routed through openrouter.ai.'
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    envVar: 'GEMINI_API_KEY',
    hint: 'Used by opencode / pi against generativelanguage.googleapis.com.'
  },
  {
    id: 'azure',
    label: 'Azure OpenAI',
    envVar: 'AZURE_OPENAI_API_KEY',
    hint: 'Used by opencode against your Azure OpenAI deployment.'
  }
]

/** Summary the renderer is allowed to see (never the plaintext). */
export interface ProviderKeyInfo {
  id: ProviderSpec['id']
  label: string
  hint: string
  isSet: boolean
}

interface Stored {
  version: 1
  keys: Record<string, string | undefined>
}

const storeFile = () => join(app.getPath('userData'), 'provider-keys.json')

function encryptSecret(v: string): string {
  if (safeStorage.isEncryptionAvailable()) {
    return ENC + safeStorage.encryptString(v).toString('base64')
  }
  return RAW + v
}

function decryptSecret(v: string): string | undefined {
  if (v.startsWith(ENC)) {
    try {
      return safeStorage.decryptString(Buffer.from(v.slice(ENC.length), 'base64'))
    } catch {
      // Key-rotation / corruption: drop the secret silently rather than
      // surfacing a crash on every list call.
      return undefined
    }
  }
  if (v.startsWith(RAW)) return v.slice(RAW.length)
  // Legacy / unknown: best-effort — assume plaintext. Avoid locking the user
  // out on a single bad row.
  return v
}

async function readAll(): Promise<Record<string, string | undefined>> {
  try {
    const raw = await fs.readFile(storeFile(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<Stored>
    const out: Record<string, string | undefined> = {}
    if (parsed && parsed.keys && typeof parsed.keys === 'object') {
      for (const [k, v] of Object.entries(parsed.keys)) {
        if (typeof v === 'string') out[k] = decryptSecret(v)
      }
    }
    return out
  } catch {
    /* missing file is fine — first run */
    return {}
  }
}

async function writeAll(keys: Record<string, string | undefined>): Promise<void> {
  // Encrypt everything that has a value; drop empty/undefined entries so the
  // file stays tight.
  const out: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(keys)) {
    if (typeof v === 'string' && v) out[k] = encryptSecret(v)
  }
  const file = storeFile()
  const tmp = file + '.tmp'
  await fs.writeFile(
    tmp,
    JSON.stringify({ version: 1, keys: out } satisfies Stored, null, 2),
    'utf8'
  )
  await fs.rename(tmp, file)
}

/** Returns the renderer-safe listing (id + isSet; never the plaintext). */
export async function listProviderKeys(): Promise<ProviderKeyInfo[]> {
  const stored = await readAll()
  return PROVIDERS.map((p) => ({
    id: p.id,
    label: p.label,
    hint: p.hint,
    isSet: typeof stored[p.id] === 'string' && stored[p.id]!.length > 0
  }))
}

/** Store or replace the plaintext for `id`. Empty input clears it. */
export async function setProviderKey(id: string, key: string): Promise<void> {
  if (!PROVIDERS.some((p) => p.id === id)) throw new Error(`unknown provider: ${id}`)
  const stored = await readAll()
  const trimmed = key.trim()
  if (trimmed) stored[id] = trimmed
  else delete stored[id]
  await writeAll(stored)
}

/** Drop the stored plaintext for `id`. */
export async function clearProviderKey(id: string): Promise<void> {
  if (!PROVIDERS.some((p) => p.id === id)) throw new Error(`unknown provider: ${id}`)
  const stored = await readAll()
  delete stored[id]
  await writeAll(stored)
}

/**
 * Read back the plaintext for one provider, intended ONLY for the agent
 * env-injection path. Never exposed via IPC to the renderer.
 *
 * Returns undefined when the key isn't set OR safeStorage couldn't decrypt
 * it (key-rotation / corruption). Callers should treat undefined as "skip
 * this env var; let the agent CLI use whatever auth it has cached".
 */
export async function getProviderKey(id: string): Promise<string | undefined> {
  const stored = await readAll()
  return stored[id]
}

/**
 * Resolve every provider's plaintext into a flat env-var bag, suitable for
 * merging into an agent PTY's `env`. Used by the launch specs so the agent
 * CLI sees ALL configured providers' keys at once — important for opencode
 * which is provider-agnostic and may pick any one based on its config.
 */
export async function envForAgent(): Promise<Record<string, string>> {
  const stored = await readAll()
  const out: Record<string, string> = {}
  for (const p of PROVIDERS) {
    const k = stored[p.id]
    if (typeof k === 'string' && k) out[p.envVar] = k
  }
  return out
}
