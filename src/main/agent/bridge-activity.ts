// Foundation (cluster gate) — bridge activity log.
//
// A ring-buffer-backed, per-session event log for the agent MCP bridge. The
// "data layer" only: NO MCP wiring here. Other tracks call `record()` from
// wherever they observe a tool call / approval / heartbeat / transport
// event. Subscribers (the renderer) get a live push on the per-session event
// channel and can pull a merged in-memory + tail-file list on demand.
//
// In-memory cap: 500 entries per session. Older entries are evicted from the
// ring and APPENDED to a single JSONL tail file at
// `userData/bridge-activity.jsonl` (rotated at 5000 lines so the file never
// grows unbounded). On `list()`, the tail is read once lazily, parsed line
// by line, and merged with the in-memory ring for a single sorted view.

import { app } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'
import type { BridgeActivityEntry, BridgeActivityKind } from '@shared/types'

const IN_MEMORY_CAP = 500
const TAIL_MAX_LINES = 5000
const TAIL_FILE = () => join(app.getPath('userData'), 'bridge-activity.jsonl')

// Per-session state. The emitter lets us push live entries to subscribers;
// the ring holds the recent window.
interface SessionState {
  ring: BridgeActivityEntry[]
  emitter: EventEmitter
}

const sessions = new Map<string, SessionState>()

function getOrCreate(sessionId: string): SessionState {
  let s = sessions.get(sessionId)
  if (s) return s
  s = { ring: [], emitter: new EventEmitter() }
  // One listener cap to keep things light; the bridge calls `record` a lot.
  s.emitter.setMaxListeners(64)
  sessions.set(sessionId, s)
  return s
}

// Append a batch of evicted entries to the JSONL tail. We accumulate writes
// by reusing the same in-flight promise so concurrent `record` calls don't
// stomp each other's .tmp + rename dance.
let pendingWrite: Promise<void> | null = null
let pendingBatch: BridgeActivityEntry[] = []

function scheduleAppend(entries: BridgeActivityEntry[]): void {
  if (entries.length === 0) return
  pendingBatch.push(...entries)
  if (pendingWrite) return
  pendingWrite = (async () => {
    while (pendingBatch.length > 0) {
      const batch = pendingBatch
      pendingBatch = []
      const file = TAIL_FILE()
      const tmp = file + '.tmp'
      try {
        // Prepend to a fresh file if the existing one is at the cap, to keep
        // a sliding window of the oldest-N lines. Read existing first; if it's
        // already over the cap, keep only the most recent TAIL_MAX_LINES.
        let existing = ''
        try {
          existing = await fs.readFile(file, 'utf8')
        } catch {
          /* missing file is fine */
        }
        const existingLines = existing.length > 0 ? existing.split('\n').filter(Boolean) : []
        const newLines = batch.map((e) => JSON.stringify(e))
        const merged = existingLines.concat(newLines)
        const trimmed =
          merged.length > TAIL_MAX_LINES ? merged.slice(merged.length - TAIL_MAX_LINES) : merged
        await fs.writeFile(tmp, trimmed.join('\n') + (trimmed.length > 0 ? '\n' : ''), 'utf8')
        await fs.rename(tmp, file)
      } catch (err) {
        // A failed tail write must not break the in-memory ring or the
        // emitter; the data is still in memory. Log and move on.
        console.warn('bridge-activity: tail write failed', err)
      }
    }
    pendingWrite = null
  })()
}

// Tail cache keyed by the mtime of the file; the in-memory map is rebuilt
// when the file changes (rare — only on rotation / first write).
let tailCache: { mtimeMs: number; entries: BridgeActivityEntry[] } | null = null

async function getTailAll(): Promise<BridgeActivityEntry[]> {
  try {
    const stat = await fs.stat(TAIL_FILE())
    if (tailCache && tailCache.mtimeMs === stat.mtimeMs) return tailCache.entries
    const raw = await fs.readFile(TAIL_FILE(), 'utf8')
    const lines = raw.split('\n').filter(Boolean)
    const out: BridgeActivityEntry[] = []
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as BridgeActivityEntry
        if (parsed && typeof parsed.sessionId === 'string' && typeof parsed.id === 'string') {
          out.push(parsed)
        }
      } catch {
        /* skip corrupt line */
      }
    }
    tailCache = { mtimeMs: stat.mtimeMs, entries: out }
    return out
  } catch {
    return [] // missing file is fine
  }
}

export function record(entry: Omit<BridgeActivityEntry, 'id' | 'ts'>): BridgeActivityEntry {
  const full: BridgeActivityEntry = {
    ...entry,
    id: randomUUID(),
    ts: Date.now()
  }
  const s = getOrCreate(full.sessionId)
  s.ring.push(full)
  const evicted =
    s.ring.length > IN_MEMORY_CAP ? s.ring.splice(0, s.ring.length - IN_MEMORY_CAP) : []
  if (evicted.length > 0) scheduleAppend(evicted)
  // Invalidate any cached tail-on-disk result so the next `list` re-reads.
  tailCache = null
  s.emitter.emit('entry', full)
  return full
}

export function list(
  sessionId: string,
  opts?: { sinceMs?: number; limit?: number }
): BridgeActivityEntry[] {
  // Synchronous path — the in-memory ring is the source of truth for "recent".
  // The on-disk tail is read asynchronously by `listAsync` for callers who want
  // the full history. Kept sync for backwards-compatible callers; the IPC
  // handler uses `listAsync`.
  const s = sessions.get(sessionId)
  if (!s) return []
  const sinceMs = opts?.sinceMs
  let out = sinceMs != null ? s.ring.filter((e) => e.ts >= sinceMs) : s.ring.slice()
  if (opts?.limit != null && opts.limit > 0) out = out.slice(-opts.limit)
  return out
}

export async function listAsync(
  sessionId: string,
  opts?: { sinceMs?: number; limit?: number }
): Promise<BridgeActivityEntry[]> {
  const s = sessions.get(sessionId)
  const ring = s?.ring ?? []
  const tail = await getTailAll()
  // Only include tail entries that belong to this session and aren't already
  // in the in-memory ring (compare by id; the ring is the most recent window).
  const ringIds = new Set(ring.map((e) => e.id))
  const merged = tail
    .filter((e) => e.sessionId === sessionId && !ringIds.has(e.id))
    .concat(ring)
    .sort((a, b) => a.ts - b.ts)
  let out = opts?.sinceMs != null ? merged.filter((e) => e.ts >= opts.sinceMs!) : merged
  if (opts?.limit != null && opts.limit > 0) out = out.slice(-opts.limit)
  return out
}

export function clear(sessionId: string): void {
  const s = sessions.get(sessionId)
  if (!s) return
  // Drop the in-memory ring for this session. The on-disk tail is kept
  // (intentional: clear() is a UI-level "current view" reset, not "wipe
  // history"); the renderer just won't see the tail until it reloads.
  s.ring = []
  s.emitter.emit('cleared')
}

export function on(sessionId: string, cb: (entry: BridgeActivityEntry) => void): () => void {
  const s = getOrCreate(sessionId)
  const handler = (entry: BridgeActivityEntry) => cb(entry)
  s.emitter.on('entry', handler)
  return () => s.emitter.off('entry', handler)
}

/**
 * Write every entry for a session (in-memory ring + on-disk tail, merged
 * and sorted by ts) to `targetPath` as JSONL. Returns the number of lines
 * written. Atomic .tmp + rename.
 */
export async function exportSession(sessionId: string, targetPath: string): Promise<number> {
  const entries = await listAsync(sessionId)
  const tmp = targetPath + '.tmp'
  const body = entries.length > 0 ? entries.map((e) => JSON.stringify(e)).join('\n') + '\n' : ''
  await fs.writeFile(tmp, body, 'utf8')
  await fs.rename(tmp, targetPath)
  return entries.length
}

// Test/maintenance helper: drop in-memory state for a session and force a
// reload of the tail on next read. Not used by IPC.
export function _resetForTests(): void {
  sessions.clear()
  tailCache = null
  pendingBatch = []
  pendingWrite = null
}

// Convenience re-export for the IPC handler: package kinds the renderer is
// allowed to see (defense-in-depth in case the wire contract is ever relaxed).
export type { BridgeActivityKind }
