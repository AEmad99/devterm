import { app, ipcMain, safeStorage } from 'electron'
import { randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import { join } from 'path'
import { IPC, type SavedConnection, type SSHHop } from '@shared/types'

/**
 * Persisted SSH connections. Stored as JSON in the OS userData directory
 * (e.g. %APPDATA%/DevTerm on Windows) which the NSIS updater never touches —
 * so saved connections survive app updates. Secret fields (passwords/
 * passphrases) are encrypted at rest with Electron safeStorage when the OS
 * keychain is available, falling back to plaintext otherwise.
 */

const storeFile = () => join(app.getPath('userData'), 'connections.json')

const ENC = 'v1:'
const RAW = 'raw:'

function encryptSecret(v?: string): string | undefined {
  if (!v) return undefined
  if (safeStorage.isEncryptionAvailable()) {
    return ENC + safeStorage.encryptString(v).toString('base64')
  }
  return RAW + v
}

function decryptSecret(v?: string): string | undefined {
  if (!v) return undefined
  if (v.startsWith(ENC)) {
    try {
      return safeStorage.decryptString(Buffer.from(v.slice(ENC.length), 'base64'))
    } catch {
      return undefined // key rotated / corrupt — drop the secret, keep the entry
    }
  }
  if (v.startsWith(RAW)) return v.slice(RAW.length)
  return v
}

function mapHop<T extends SSHHop>(hop: T, fn: (s?: string) => string | undefined): T {
  return { ...hop, password: fn(hop.password), passphrase: fn(hop.passphrase) }
}

/** Toggle encryption on the secret fields of a connection (and its jump hop). */
function transform(c: SavedConnection, fn: (s?: string) => string | undefined): SavedConnection {
  const out = mapHop(c, fn)
  if (out.jump) out.jump = mapHop(out.jump, fn)
  return out
}

async function readAll(): Promise<SavedConnection[]> {
  try {
    const raw = await fs.readFile(storeFile(), 'utf8')
    const parsed = JSON.parse(raw)
    const list: SavedConnection[] = Array.isArray(parsed?.connections) ? parsed.connections : []
    return list.map((c) => transform(c, decryptSecret))
  } catch {
    return [] // missing or unreadable file → no saved connections
  }
}

async function writeAll(list: SavedConnection[]): Promise<void> {
  const encrypted = list.map((c) => transform(c, encryptSecret))
  const tmp = storeFile() + '.tmp'
  // Owner-only perms: this file can hold credentials (encrypted when the OS
  // keychain is available, otherwise plaintext), so it must never be group/
  // world-readable on POSIX. `mode` is a no-op on Windows (per-user %APPDATA%
  // already isolates it); the trailing chmod tightens an entry that pre-existed
  // with looser perms.
  await fs.writeFile(tmp, JSON.stringify({ version: 1, connections: encrypted }, null, 2), {
    encoding: 'utf8',
    mode: 0o600
  })
  await fs.rename(tmp, storeFile()) // atomic replace so a crash mid-write can't corrupt the store
  await fs.chmod(storeFile(), 0o600).catch(() => {})
}

// Serialize read-modify-write mutations so concurrent saves/deletes can't
// interleave readAll→writeAll and silently drop entries.
let mutationQueue: Promise<unknown> = Promise.resolve()

function enqueueMutation<T>(op: () => Promise<T>): Promise<T> {
  const next = mutationQueue.then(op, op)
  mutationQueue = next.catch(() => undefined)
  return next
}

export function registerConnectionsIpc(): void {
  ipcMain.handle(IPC.connectionsList, () => readAll())

  ipcMain.handle(IPC.connectionsSave, (_e, conn: SavedConnection) =>
    enqueueMutation(async () => {
      const list = await readAll()
      const id = conn.id || randomUUID()
      const entry: SavedConnection = { ...conn, id }
      const idx = list.findIndex((c) => c.id === id)
      if (idx >= 0) list[idx] = entry
      else list.push(entry)
      await writeAll(list)
      return list
    })
  )

  ipcMain.handle(IPC.connectionsDelete, (_e, id: string) =>
    enqueueMutation(async () => {
      const list = (await readAll()).filter((c) => c.id !== id)
      await writeAll(list)
      return list
    })
  )
}
