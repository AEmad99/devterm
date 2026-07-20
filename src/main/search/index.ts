/**
 * Global Terminal Search Index (MVP)
 * Stores the most recent N lines from each session and supports simple
 * string search. Lines carry lightweight metadata for rendering results.
 *
 * The in-memory ring is the hot path. When `search.persist` is on,
 * `pushLine` also appends each line to the optional JSONL tail
 * (`./persist.ts`) so the index survives a restart. The tail is
 * rehydrated by callers via `rehydrateSession` (which then calls
 * `seedLines`).
 *
 * All ingest paths (`pushLine`, `seedLines`) run lines through `stripAnsi`
 * (`./ansi.ts`) so stored text — and therefore search results — is plain
 * text, free of the raw ANSI/VT sequences terminal output carries.
 */

import * as persist from './persist'
import { stripAnsi } from './ansi'

export interface SearchResult {
  sessionId: string
  sessionTitle: string
  lineNumber: number
  text: string
  kind: 'live' | 'history' | 'detached'
}

interface StoredLine {
  text: string
  lineNumber: number
}

interface SessionRecord {
  title: string
  /** Fixed-size circular buffer; avoids O(N) shift/renumber work per chunk. */
  lines: Array<StoredLine | undefined>
  start: number
  size: number
  nextLineNumber: number
  /** Incomplete terminal line carried across PTY/SSH chunks. */
  pending: string
}

const MAX_LINES_PER_SESSION = 2000

export class SearchIndex {
  private index = new Map<string, SessionRecord>()

  private createRecord(title: string): SessionRecord {
    return {
      title,
      lines: new Array(MAX_LINES_PER_SESSION),
      start: 0,
      size: 0,
      nextLineNumber: 1,
      pending: ''
    }
  }

  private append(rec: SessionRecord, text: string): void {
    if (!text) return
    const stored = { text, lineNumber: rec.nextLineNumber++ }
    if (rec.size < MAX_LINES_PER_SESSION) {
      rec.lines[(rec.start + rec.size) % MAX_LINES_PER_SESSION] = stored
      rec.size++
      return
    }
    rec.lines[rec.start] = stored
    rec.start = (rec.start + 1) % MAX_LINES_PER_SESSION
  }

  setSessionTitle(sessionId: string, title: string) {
    const rec = this.index.get(sessionId)
    if (rec) {
      rec.title = title
    } else {
      this.index.set(sessionId, this.createRecord(title))
    }
  }

  /** Record a new live line (called from PTY data handler). */
  pushLine(sessionId: string, text: string, titleFallback?: string) {
    let rec = this.index.get(sessionId)
    if (!rec) {
      rec = this.createRecord(titleFallback ?? sessionId)
      this.index.set(sessionId, rec)
    }
    // IPC chunks are transport batches, not terminal lines. Carry the partial
    // tail between chunks and commit only complete LF-delimited lines. Within
    // a line, a carriage return means "rewrite this line" (progress bars/TUIs),
    // so only the final visible segment is indexed.
    const parts = text.replace(/\r\n/g, '\n').split('\n')
    for (let i = 0; i < parts.length - 1; i++) {
      const logical = rec.pending + parts[i]
      const visible = logical.slice(logical.lastIndexOf('\r') + 1)
      const clean = stripAnsi(visible)
      if (clean) {
        this.append(rec, clean)
        try {
          persist.push(sessionId, clean)
        } catch {
          /* persistence must never break terminal output */
        }
      }
      rec.pending = ''
    }
    const tail = parts[parts.length - 1]
    const combined = rec.pending + tail
    const lastCr = combined.lastIndexOf('\r')
    rec.pending = lastCr >= 0 ? combined.slice(lastCr + 1) : combined
    // Bound a command that streams forever without LF so search ingestion can
    // never retain an unbounded string.
    if (rec.pending.length > 16_384) rec.pending = rec.pending.slice(-16_384)
  }

  /** Remove all lines for a session (on kill). */
  clearSession(sessionId: string) {
    this.index.delete(sessionId)
    void persist.clearSession(sessionId)
  }

  /**
   * Seed the index from an array of already-rendered lines (e.g. read from
   * xterm's buffer on first open). Replaces any existing lines for the session
   * so live output can append from the correct line number.
   */
  seedLines(sessionId: string, lines: string[], title: string) {
    const rec = this.createRecord(title)
    for (const text of lines.slice(-MAX_LINES_PER_SESSION)) {
      const clean = stripAnsi(text)
      if (clean) this.append(rec, clean)
    }
    this.index.set(sessionId, rec)
  }

  query(q: string, limit = 50): SearchResult[] {
    if (!q.trim()) return []
    const lower = q.toLowerCase()
    const out: SearchResult[] = []
    for (const [sid, rec] of this.index.entries()) {
      for (let i = 0; i < rec.size; i++) {
        const ln = rec.lines[(rec.start + i) % MAX_LINES_PER_SESSION]
        if (!ln) continue
        if (ln.text.toLowerCase().includes(lower)) {
          out.push({
            sessionId: sid,
            sessionTitle: rec.title,
            lineNumber: ln.lineNumber,
            text: ln.text,
            kind: 'live'
          })
          if (out.length >= limit) return out
        }
      }
    }
    return out
  }
}

// Singleton used by IPC + pty data stream.
export const globalSearchIndex = new SearchIndex()

/** Forwarded setter so the main module can wire the renderer's setting
 * without exposing the SearchIndex internals. */
export function setPersistEnabled(v: boolean): void {
  persist.setEnabled(v)
}

/** Rehydrate a session from its on-disk tail (returns the lines so the
 * caller can decide whether to feed them through `seedLines`). */
export async function rehydrateSession(sessionId: string): Promise<string[]> {
  return persist.rehydrate(sessionId)
}

/** Flush every pending persist write (called on app quit). */
export async function flushPersist(): Promise<void> {
  return persist.flushAll()
}
