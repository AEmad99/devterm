/**
 * GlobalSearchModal – floating search UI for live terminal output.
 * Triggered by Ctrl+Shift+F (or via hotkey system when wired).
 */
import { useState, useEffect } from 'react'
import { SearchResult } from '@shared/types'
import { useDebouncedCallback } from '../../lib/debounce'

interface Props {
  isOpen: boolean
  onClose: () => void
  onJump: (sessionId: string, line: number) => void
}

export const GlobalSearchModal: React.FC<Props> = ({ isOpen, onClose, onJump }) => {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!isOpen) {
      setQuery('')
      setResults([])
    }
  }, [isOpen])

  const runSearch = async (q: string) => {
    if (!q.trim()) {
      setResults([])
      return
    }
    setLoading(true)
    try {
      const hits = await window.devterm.search.query(q)
      setResults(hits)
    } catch (e) {
      console.error('search failed', e)
      setResults([])
    } finally {
      setLoading(false)
    }
  }

  const debouncedRun = useDebouncedCallback((q: string) => runSearch(q), 180)

  if (!isOpen) return null

  return (
    <div
      className="fixed inset-0 z-[200] flex items-start justify-center pt-[12vh] bg-black/40"
      onClick={onClose}
    >
      <div
        className="w-[620px] rounded-xl border border-border bg-bg/95 backdrop-blur shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <input
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              debouncedRun(e.target.value)
            }}
            placeholder="Search across all terminals..."
            className="flex-1 bg-transparent text-lg outline-none placeholder:text-muted font-mono"
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose()
            }}
          />
          <button onClick={onClose} className="text-muted text-sm px-2 hover:text-fg">
            ESC
          </button>
        </div>

        <div className="max-h-[52vh] overflow-auto text-sm">
          {loading && <div className="px-4 py-8 text-center text-muted">Searching...</div>}
          {!loading && results.length === 0 && query.trim() !== '' && (
            <div className="px-4 py-8 text-center text-muted">No matches found.</div>
          )}
          {results.map((r, idx) => (
            <button
              key={idx}
              onClick={() => {
                onJump(r.sessionId, r.lineNumber)
                onClose()
              }}
              className="w-full text-left px-4 py-2.5 font-mono border-b border-border/60 hover:bg-surface last:border-none"
            >
              <div className="flex justify-between text-xs text-muted mb-0.5">
                <span>{r.sessionTitle}</span>
                <span>line {r.lineNumber}</span>
              </div>
              <div className="truncate text-fg/90">{r.text}</div>
            </button>
          ))}
        </div>

        <div className="text-[10px] px-4 py-2 text-muted border-t border-border flex justify-between">
          <span>Global search • live PTY only (MVP)</span>
          <span>{results.length} results</span>
        </div>
      </div>
    </div>
  )
}
