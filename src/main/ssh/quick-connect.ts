// QuickConnect: a small JSON store of recent host:port:user triples, used
// to autocomplete the host field in ConnectionForm. The contract type
// (`QuickConnectEntry`) already exists in `@shared/types`. No secrets —
// only the connection target.

import { app } from 'electron'
import { promises as fsp } from 'fs'
import { join } from 'path'
import type { QuickConnectEntry } from '@shared/types'

const userDataPath = () => app.getPath('userData')
const storeFile = () => join(userDataPath(), 'quick-connect.json')

const MAX_ENTRIES = 20

let cache: QuickConnectEntry[] | null = null

async function load(): Promise<QuickConnectEntry[]> {
  if (cache) return cache
  try {
    const raw = await fsp.readFile(storeFile(), 'utf8')
    const parsed = JSON.parse(raw) as { entries?: unknown }
    cache = Array.isArray(parsed.entries)
      ? (parsed.entries.filter(isEntry) as QuickConnectEntry[])
      : []
  } catch {
    cache = []
  }
  return cache
}

function isEntry(v: unknown): v is QuickConnectEntry {
  if (!v || typeof v !== 'object') return false
  const r = v as Record<string, unknown>
  return (
    typeof r.host === 'string' &&
    typeof r.port === 'number' &&
    typeof r.username === 'string' &&
    typeof r.lastUsedAt === 'number'
  )
}

async function persist(): Promise<void> {
  if (!cache) return
  const tmp = storeFile() + '.tmp'
  await fsp.writeFile(tmp, JSON.stringify({ entries: cache }, null, 2), 'utf8')
  await fsp.rename(tmp, storeFile())
}

export async function list(): Promise<QuickConnectEntry[]> {
  // Newest first.
  return [...(await load())].sort((a, b) => b.lastUsedAt - a.lastUsedAt)
}

export async function record(
  host: string,
  port: number,
  username: string
): Promise<void> {
  const entries = await load()
  const dedupKey = `${host}|${port}|${username}`
  // Bump lastUsedAt and dedupe by host/port/username.
  const next: QuickConnectEntry = { host, port, username, lastUsedAt: Date.now() }
  const idx = entries.findIndex(
    (e) => `${e.host}|${e.port}|${e.username}` === dedupKey
  )
  if (idx >= 0) entries.splice(idx, 1)
  entries.push(next)
  // Cap at MAX_ENTRIES, dropping the oldest.
  while (entries.length > MAX_ENTRIES) entries.shift()
  cache = entries
  await persist()
}
