import { app } from 'electron'
import { createHash } from 'crypto'
import { chmodSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { promises as fsp } from 'fs'
import { dirname, join } from 'path'

/**
 * Trust-on-first-use known-hosts store. Persists a sha256 fingerprint per
 * `host:port` and flags mismatches (possible MITM) — the safety baseline from
 * §7.1 ("host-key verification, no silent accept"). The renderer is notified of
 * new/mismatched keys via an SSHStatus event.
 */

export type HostKeyVerdict =
  | { ok: true; firstUse: boolean; fingerprint: string }
  | { ok: false; fingerprint: string; expected: string }

export interface KnownHost {
  /** `host:port` identifier used as the store key. */
  hostId: string
  fingerprint: string
}

let cache: Record<string, string> | null = null

function storePath(): string {
  return join(app.getPath('userData'), 'known_hosts.json')
}

function load(): Record<string, string> {
  if (cache) return cache
  const p = storePath()
  try {
    cache = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {}
  } catch {
    cache = {}
  }
  return cache!
}

function persist(): void {
  const p = storePath()
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify(cache ?? {}, null, 2), { mode: 0o600 })
  // mode only applies at creation; re-assert it so perms stay tight.
  try {
    chmodSync(p, 0o600)
  } catch {
    /* ignore — best effort on exotic filesystems */
  }
}

async function persistAsync(): Promise<void> {
  const p = storePath()
  await fsp.mkdir(dirname(p), { recursive: true })
  await fsp.writeFile(p, JSON.stringify(cache ?? {}, null, 2), {
    mode: 0o600
  })
  try {
    await fsp.chmod(p, 0o600)
  } catch {
    /* ignore — best effort */
  }
}

export function fingerprintOf(key: Buffer): string {
  return 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '')
}

/**
 * Check a host key against the store WITHOUT recording it. First-use keys
 * return `firstUse: true` and are only persisted once the operator explicitly
 * trusts them via {@link trustHostKey} — see the dialog prompt in
 * `connection.ts`.
 */
export function verifyHostKey(hostId: string, key: Buffer): HostKeyVerdict {
  const store = load()
  const fingerprint = fingerprintOf(key)
  const expected = store[hostId]
  if (!expected) {
    return { ok: true, firstUse: true, fingerprint }
  }
  if (expected !== fingerprint) {
    return { ok: false, fingerprint, expected }
  }
  return { ok: true, firstUse: false, fingerprint }
}

/** Record a first-use host key after the operator accepted it. */
export function trustHostKey(hostId: string, fingerprint: string): void {
  const store = load()
  store[hostId] = fingerprint
  persist()
}

/**
 * List every trusted host. Async to keep the file IO off the main thread
 * when called from the UI (the SSH handshake still uses the sync path).
 * Sorted by hostId for stable display.
 */
export async function list(): Promise<KnownHost[]> {
  const store = load()
  return Object.keys(store)
    .sort()
    .map((hostId) => ({ hostId, fingerprint: store[hostId] }))
}

/**
 * Forget a trusted host. The next connect to that host will re-trigger the
 * TOFU `hostkey-new` SSHStatus event so the operator can re-accept the key.
 * No-op if the host isn't trusted.
 */
export async function remove(hostId: string): Promise<void> {
  const store = load()
  if (!(hostId in store)) return
  delete store[hostId]
  await persistAsync()
}
