import { app } from 'electron'
import { createHash } from 'crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
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
}

export function fingerprintOf(key: Buffer): string {
  return 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '')
}

/** Check (and on first use, record) a host key. */
export function verifyHostKey(hostId: string, key: Buffer): HostKeyVerdict {
  const store = load()
  const fingerprint = fingerprintOf(key)
  const expected = store[hostId]
  if (!expected) {
    store[hostId] = fingerprint
    persist()
    return { ok: true, firstUse: true, fingerprint }
  }
  if (expected !== fingerprint) {
    return { ok: false, fingerprint, expected }
  }
  return { ok: true, firstUse: false, fingerprint }
}
