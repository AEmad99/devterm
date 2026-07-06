/**
 * Global Terminal Search Index (MVP)
 * Stores the most recent N lines from each session and supports simple
 * string search. Lines carry lightweight metadata for rendering results.
 */

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

const MAX_LINES_PER_SESSION = 2000

export class SearchIndex {
  // Map<sessionId, {title, lines[]}>
  private index = new Map<string, { title: string; lines: StoredLine[] }>()

  setSessionTitle(sessionId: string, title: string) {
    const rec = this.index.get(sessionId)
    if (rec) {
      rec.title = title
    } else {
      this.index.set(sessionId, { title, lines: [] })
    }
  }

  /** Record a new live line (called from PTY data handler). */
  pushLine(sessionId: string, text: string, titleFallback?: string) {
    let rec = this.index.get(sessionId)
    if (!rec) {
      rec = { title: titleFallback ?? sessionId, lines: [] }
      this.index.set(sessionId, rec)
    }
    const lineNumber = rec.lines.length + 1
    rec.lines.push({ text, lineNumber })
    if (rec.lines.length > MAX_LINES_PER_SESSION) {
      rec.lines.shift()
      for (let i = 0; i < rec.lines.length; i++) rec.lines[i].lineNumber = i + 1
    }
  }

  /** Remove all lines for a session (on kill). */
  clearSession(sessionId: string) {
    this.index.delete(sessionId)
  }

  /**
   * Seed the index from an array of already-rendered lines (e.g. read from
   * xterm's buffer on first open). Replaces any existing lines for the session
   * so live output can append from the correct line number.
   */
  seedLines(sessionId: string, lines: string[], title: string) {
    const stored: StoredLine[] = lines.slice(-MAX_LINES_PER_SESSION).map((text, i) => ({
      text,
      lineNumber: i + 1
    }))
    this.index.set(sessionId, { title, lines: stored })
  }

  query(q: string, limit = 50): SearchResult[] {
    if (!q.trim()) return []
    const lower = q.toLowerCase()
    const out: SearchResult[] = []
    for (const [sid, rec] of this.index.entries()) {
      for (const ln of rec.lines) {
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
