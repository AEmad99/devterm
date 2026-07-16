/**
 * GlobalSearchModal – floating search UI for live terminal output.
 * Triggered by Ctrl/Cmd+Alt+F (hotkey id `globalSearch`).
 */
import { useState, useEffect } from 'react'
import { SearchResult } from '@shared/types'
import { useDebouncedCallback } from '../../lib/debounce'
import { useSessions } from '../../store/sessions'

interface Props {
  isOpen: boolean
  onClose: () => void
  onJump: (sessionId: string, line: number) => void
}

export const GlobalSearchModal: React.FC<Props> = ({ isOpen, onClose, onJump }) => {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  // The main-side index is seeded with the session GUID as the title; resolve
  // live session titles ("Local 1", "user@host") for display, falling back to
  // whatever the index stored when the session is gone.
  const sessions = useSessions((s) => s.sessions)
  const rowTitle = (r: SearchResult): string =>
    sessions.find((s) => s.id === r.sessionId)?.title ?? r.sessionTitle

  useEffect(() => {
    if (!isOpen) {
      setQuery('')
      setResults([])
      setFailed(false)
    }
  }, [isOpen])

  const runSearch = async (q: string) => {
    if (!q.trim()) {
      setResults([])
      setFailed(false)
      return
    }
    setLoading(true)
    try {
      const hits = await window.devterm.search.query(q)
      setResults(hits)
      setFailed(false)
    } catch (e) {
      console.error('search failed', e)
      setResults([])
      setFailed(true)
    } finally {
      setLoading(false)
    }
  }

  const debouncedRun = useDebouncedCallback((q: string) => runSearch(q), 180)

  if (!isOpen) return null

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="palette gsearch" onClick={(e) => e.stopPropagation()}>
        <div className="gsearch-head">
          <input
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              debouncedRun(e.target.value)
            }}
            placeholder="Search across all terminals..."
            className="palette-input"
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose()
            }}
          />
          <button onClick={onClose} className="gsearch-esc" title="Close">
            ESC
          </button>
        </div>

        <div className="gsearch-list">
          {loading && <div className="gsearch-state">Searching…</div>}
          {!loading && failed && <div className="gsearch-state">Search failed — try again.</div>}
          {!loading && !failed && results.length === 0 && query.trim() !== '' && (
            <div className="gsearch-state">No matches found.</div>
          )}
          {results.map((r, idx) => (
            <button
              key={idx}
              onClick={() => {
                onJump(r.sessionId, r.lineNumber)
                onClose()
              }}
              className="gsearch-row"
            >
              <div className="gsearch-row-meta">
                <span>{rowTitle(r)}</span>
                <span>line {r.lineNumber}</span>
              </div>
              <div className="gsearch-row-text">{r.text}</div>
            </button>
          ))}
        </div>

        <div className="gsearch-foot">
          <span>Global search · local + remote terminals</span>
          <span>{results.length} results</span>
        </div>
      </div>
    </div>
  )
}
