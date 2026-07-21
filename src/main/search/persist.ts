// Optional per-session JSONL tail for the global search index.
//
// The in-memory `SearchIndex` (search/index.ts) holds the most recent
// 2000 lines per session in RAM and is the hot path. When the
// `search.persist` setting is on, this module also appends each pushed
// line to a JSONL file under `userData/search/<sessionId>.jsonl` so the
// index survives a restart. The file is created lazily on first push
// and rotated at MAX_LINES (FIFO).
//
// Cost: one fs.appendFile per push (coalesced via scheduleFlush) when
// enabled. Disabled by default — the user opts in via Settings →
// Behavior → "Persist search history across restarts".

import { app } from 'electron'
import { promises as fsp, mkdirSync, existsSync } from 'fs'
import { join, dirname } from 'path'

const MAX_LINES = 5000
/** Bound the in-memory retry queue when appendFile keeps failing. */
const MAX_PENDING = 2000
const FLUSH_DEBOUNCE_MS = 500

interface SessionTail {
  /** Lines queued but not yet flushed. */
  pending: string[]
  /** Lines already persisted (FIFO cap, mirrors the in-memory tail). */
  persisted: string[]
  flushTimer: NodeJS.Timeout | null
  /** Serialize flush/truncate so a timer flush can't race flushAll/truncate. */
  writeChain: Promise<void>
}

const tails = new Map<string, SessionTail>()
let enabled = false

function tailDir(): string {
  return join(app.getPath('userData'), 'search')
}

function tailFile(sessionId: string): string {
  // Defensively strip path separators so the sessionId can never escape its
  // own file (e.g. a malicious store pushing "../../etc/passwd").
  const safe = sessionId.replace(/[\\/:*?"<>|]/g, '_')
  return join(tailDir(), `${safe}.jsonl`)
}

function ensureDir(): void {
  mkdirSync(tailDir(), { recursive: true })
}

export function setEnabled(v: boolean): void {
  enabled = v
  if (!v) {
    // Drop in-memory state; on-disk files are left in place so a re-enable
    // picks up where the user left off. If the user wants a clean slate,
    // they can clear the file manually.
    for (const t of tails.values()) {
      if (t.flushTimer) clearTimeout(t.flushTimer)
    }
    tails.clear()
  }
}

function getTail(sessionId: string): SessionTail {
  let t = tails.get(sessionId)
  if (!t) {
    t = { pending: [], persisted: [], flushTimer: null, writeChain: Promise.resolve() }
    tails.set(sessionId, t)
  }
  return t
}

function scheduleFlush(t: SessionTail, sessionId: string): void {
  if (t.flushTimer) return
  t.flushTimer = setTimeout(() => {
    t.flushTimer = null
    void flush(t, sessionId)
  }, FLUSH_DEBOUNCE_MS)
}

async function flush(t: SessionTail, sessionId: string): Promise<void> {
  if (t.pending.length === 0) return
  const run = t.writeChain
    .catch(() => {
      /* keep chain alive */
    })
    .then(async () => {
      if (t.pending.length === 0) return
      ensureDir()
      const lines = t.pending.splice(0)
      const file = tailFile(sessionId)
      const data = lines.map((l) => JSON.stringify({ t: Date.now(), l })).join('\n') + '\n'
      try {
        await fsp.appendFile(file, data, 'utf8')
      } catch (err) {
        console.warn('search-persist: append failed for', sessionId, err)
        // Put the lines back so the next push retries, but bound the queue so
        // a persistently failing disk can't grow RAM without limit.
        t.pending.unshift(...lines)
        if (t.pending.length > MAX_PENDING) {
          t.pending.splice(0, t.pending.length - MAX_PENDING)
        }
        return
      }
      t.persisted.push(...lines)
      // FIFO cap: drop the oldest when we exceed the limit.
      if (t.persisted.length > MAX_LINES) {
        t.persisted.splice(0, t.persisted.length - MAX_LINES)
        // Rewrite the file with the surviving lines so the cap is durable.
        await truncate(t, sessionId)
      }
    })
  t.writeChain = run
  await run
}

async function truncate(t: SessionTail, sessionId: string): Promise<void> {
  const data = t.persisted.map((l) => JSON.stringify({ t: Date.now(), l })).join('\n') + '\n'
  const file = tailFile(sessionId)
  const tmp = file + '.tmp'
  try {
    // Atomic replace: a crash mid-write can't leave a half-truncated tail.
    await fsp.writeFile(tmp, data, 'utf8')
    await fsp.rename(tmp, file)
  } catch (err) {
    console.warn('search-persist: truncate failed for', sessionId, err)
    try {
      await fsp.unlink(tmp)
    } catch {
      /* ignore */
    }
  }
}

/** Append a line to the persistent tail. No-op when disabled. */
export function push(sessionId: string, line: string): void {
  if (!enabled) return
  const t = getTail(sessionId)
  t.pending.push(line)
  scheduleFlush(t, sessionId)
}

/** Drop the in-memory and on-disk tail for a session (e.g. on kill). */
export async function clearSession(sessionId: string): Promise<void> {
  const t = tails.get(sessionId)
  if (t?.flushTimer) clearTimeout(t.flushTimer)
  tails.delete(sessionId)
  const file = tailFile(sessionId)
  if (existsSync(file)) {
    try {
      await fsp.unlink(file)
    } catch (err) {
      console.warn('search-persist: unlink failed for', sessionId, err)
    }
  }
}

/** Rehydrate lines from the on-disk tail (called on session open). */
export async function rehydrate(sessionId: string): Promise<string[]> {
  if (!enabled) return []
  const file = tailFile(sessionId)
  if (!existsSync(file)) return []
  try {
    const raw = await fsp.readFile(file, 'utf8')
    const out: string[] = []
    for (const ln of raw.split('\n')) {
      if (!ln) continue
      try {
        const parsed = JSON.parse(ln) as { l: string }
        out.push(parsed.l)
      } catch {
        /* skip malformed line */
      }
    }
    // Mirror into the in-memory tail map so subsequent push() calls append
    // onto a FIFO-capped window.
    const t = getTail(sessionId)
    t.persisted = [...out]
    return out
  } catch (err) {
    console.warn('search-persist: rehydrate failed for', sessionId, err)
    return []
  }
}

/** Flush every pending tail (called on app quit). */
export async function flushAll(): Promise<void> {
  const ops: Promise<void>[] = []
  for (const [sessionId, t] of tails.entries()) {
    if (t.flushTimer) clearTimeout(t.flushTimer)
    t.flushTimer = null
    if (t.pending.length > 0) ops.push(flush(t, sessionId))
  }
  await Promise.allSettled(ops)
}

// `dirname` is used to ensure the dir exists; re-export so tsc doesn't drop it.
void dirname
