import { useEffect, useMemo, useRef, useState } from 'react'
import type { HistoryResult, Snippet } from '@shared/types'
import { activeSession, runInActive } from '../../lib/input'
import {
  applyPlaceholders,
  clearCachedPlaceholders,
  extractPlaceholders,
  persistValues,
  prefilledValues
} from '../../lib/snippets'
import {
  buildFrecency,
  filterHistory,
  normalizeForDedupe,
  snippetCommandSet,
  type FrecencyEntry
} from '../../lib/history-frecency'

// Fuzzy-ish filter: every whitespace-separated term must appear (case-insensitive).
function termsOf(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean)
}
function matches(s: Snippet, terms: string[]): boolean {
  const hay =
    `${s.name} ${s.command} ${s.description ?? ''} ${(s.tags ?? []).join(' ')}`.toLowerCase()
  return terms.every((t) => hay.includes(t))
}

// One selectable palette entry: a saved snippet, or a frecency-ranked history row.
type Item =
  | { kind: 'snippet'; snippet: Snippet }
  | { kind: 'history'; command: string; count: number }

export default function CommandPalette({
  onRun,
  onClose
}: {
  /** Called right before a command is sent, so the host can switch to the terminals view. */
  onRun: () => void
  onClose: () => void
}) {
  const [snippets, setSnippets] = useState<Snippet[]>([])
  const [hist, setHist] = useState<HistoryResult | null>(null)
  const [scopeLabel, setScopeLabel] = useState('Local')
  // `saved` tracks history commands the user has promoted to a snippet in
  // this session — drives the "✓" badge so they don't get re-saved.
  const [saved, setSaved] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState('')
  const [sel, setSel] = useState(0)
  const [chosen, setChosen] = useState<Snippet | null>(null)
  const [values, setValues] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  // Bumped when the user clicks "Clear recent values" so the form re-pre-fills
  // from an (intentionally) empty cache.
  const [clearNonce, setClearNonce] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const firstParamRef = useRef<HTMLInputElement>(null)
  const focusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    window.devterm.snippets.list().then(setSnippets)
    // History is scoped to wherever the active terminal points: a remote session's
    // own shell history when focused on a remote, otherwise this machine's.
    const s = activeSession()
    const remote = s?.kind === 'remote'
    setScopeLabel(remote ? 'Remote' : 'Local')
    window.devterm.history
      .query(remote ? { scope: 'remote', sessionId: s!.id } : { scope: 'local' })
      .then(setHist)
      .catch(() => setHist({ recent: [], frequent: [] }))
    inputRef.current?.focus()
    return () => {
      if (focusTimerRef.current) {
        clearTimeout(focusTimerRef.current)
        focusTimerRef.current = null
      }
    }
  }, [])

  // Snippets that match the query (named, parameterizable saved commands).
  const snipMatches = useMemo(() => {
    const terms = termsOf(query)
    return snippets.filter((s) => matches(s, terms))
  }, [snippets, query])

  // Frecency list = merged + scored, filtered against saved snippets (so the
  // user doesn't see the same command twice — once as a snippet, once in
  // history). Capped so the list stays scannable. Whitespace-tolerant dedupe
  // means a " ssh …" in history hides behind the trimmed snippet version.
  const histMatches = useMemo<FrecencyEntry[]>(() => {
    const frec = buildFrecency(hist)
    const snippetCmds = snippetCommandSet(snippets)
    return filterHistory(frec, snippetCmds, query, query ? 60 : 12)
  }, [hist, snippets, query])

  // The union of "commands already saved as a snippet (any name)" — for the
  // ✓ indicator. This is broader than the local `saved` set, which only
  // tracks in-session saves; without the cross-name check, a history command
  // that was previously saved as e.g. "Restart nginx" would re-show the "+"
  // even though the snippet is right there under a different name.
  const savedAsSnippetCmds = useMemo(() => {
    const out = new Set<string>()
    for (const s of snippets) out.add(normalizeForDedupe(s.command))
    return out
  }, [snippets])

  // Flat list backing keyboard navigation; rendered with section headers below.
  const items = useMemo<Item[]>(
    () => [
      ...snipMatches.map((s) => ({ kind: 'snippet', snippet: s }) as Item),
      ...histMatches.map((h) => ({ kind: 'history', command: h.command, count: h.count }) as Item)
    ],
    [snipMatches, histMatches]
  )

  // Keep the selection in range as the list changes.
  useEffect(() => {
    setSel((i) => Math.max(0, Math.min(i, items.length - 1)))
  }, [items.length])

  // Send a fully-resolved command, or surface a message on failure.
  const send = (command: string, execute: boolean) => {
    onRun()
    if (runInActive(command, execute)) onClose()
    else setError('No active terminal to send the command to.')
  }

  // Pick a snippet: send it directly, or open the placeholder form first.
  const choose = (s: Snippet, execute: boolean) => {
    if (extractPlaceholders(s.command).length === 0) {
      send(s.command, execute)
      return
    }
    setChosen(s)
    // Pre-fill from the sessionStorage cache; clearNonce forces a re-read
    // after the user explicitly clears the cache.
    setValues(prefilledValues(s.id, s.command))
    setError(null)
    if (focusTimerRef.current) clearTimeout(focusTimerRef.current)
    focusTimerRef.current = setTimeout(() => {
      focusTimerRef.current = null
      firstParamRef.current?.focus()
    }, 0)
  }

  const activate = (item: Item | undefined, execute: boolean) => {
    if (!item) return
    if (item.kind === 'snippet') choose(item.snippet, execute)
    else send(item.command, execute)
  }

  // Promote a history command to a saved snippet (default name = the command).
  const saveAsSnippet = async (command: string) => {
    const list = await window.devterm.snippets.save({
      id: '',
      name: command.length > 80 ? command.slice(0, 80) : command,
      command,
      tags: ['history']
    })
    setSnippets(list)
    setSaved((s) => new Set(s).add(command))
  }

  const submitParams = (execute: boolean) => {
    if (!chosen) return
    // Write the values back to the per-snippet cache so the next open of this
    // form (in the same tab) pre-fills them again. submitParams is also the
    // point of no return: anything in `values` is what the user just decided.
    persistValues(chosen.id, chosen.command, values)
    send(applyPlaceholders(chosen.command, values), execute)
  }

  const clearRecentValues = () => {
    clearCachedPlaceholders()
    setValues({})
    setClearNonce((n) => n + 1)
  }
  // Touch clearNonce so the effect re-fires (and re-prefills, finding nothing).
  void clearNonce

  const onListKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSel((i) => Math.min(i + 1, items.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSel((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      activate(items[sel], !e.shiftKey)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  const placeholders = chosen ? extractPlaceholders(chosen.command) : []
  const hasHistory = !!hist && (hist.recent.length > 0 || hist.frequent.length > 0)

  // True when the user has at least one entry in the placeholder cache; only
  // show the "Clear recent values" button when there's something to clear.
  // (We don't try to read the cache from React state — the storage layer is
  // opaque — so we just always render it; the no-op case is a no-op call.)
  const canClearCache = placeholders.length > 0

  // True when a history row's command has been saved (under any name) as a
  // snippet. Cross-name match: the local `saved` set only covers saves the
  // user just did in this palette session.
  const isSavedHistory = (cmd: string) =>
    saved.has(cmd) || savedAsSnippetCmds.has(normalizeForDedupe(cmd))

  // Row renderer keyed off the global index so selection works across sections.
  const row = (item: Item, idx: number) => {
    const selected = idx === sel
    if (item.kind === 'snippet') {
      return (
        <div
          key={`s-${item.snippet.id}`}
          className={`palette-row ${selected ? 'sel' : ''}`}
          onMouseEnter={() => setSel(idx)}
          onClick={() => activate(item, true)}
        >
          <div className="palette-name">{item.snippet.name}</div>
          <div className="palette-cmd sn-mono">{item.snippet.command}</div>
        </div>
      )
    }
    const savedAlready = isSavedHistory(item.command)
    return (
      <div
        key={`h-${item.command}`}
        className={`palette-row ${selected ? 'sel' : ''}`}
        onMouseEnter={() => setSel(idx)}
        onClick={() => activate(item, true)}
      >
        <div className="palette-histrow">
          <span className="palette-cmd sn-mono">{item.command}</span>
          {item.count > 1 && (
            <span className="palette-count" title={`run ${item.count} times`}>
              {item.count}×
            </span>
          )}
          <button
            className="palette-save"
            title={savedAlready ? 'Saved as snippet' : 'Save as snippet'}
            onClick={(e) => {
              e.stopPropagation()
              if (!savedAlready) void saveAsSnippet(item.command)
            }}
          >
            {savedAlready ? '✓' : '+'}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        {!chosen ? (
          <>
            <input
              ref={inputRef}
              className="palette-input"
              value={query}
              placeholder="Run a snippet or recent command…"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onListKey}
            />
            <div className="palette-list">
              {items.length === 0 ? (
                <div className="palette-empty">
                  {snippets.length === 0 && !hasHistory
                    ? 'No snippets or command history yet — run some commands or add a snippet.'
                    : 'No matches.'}
                </div>
              ) : (
                <>
                  {snipMatches.length > 0 && <div className="palette-section">Snippets</div>}
                  {snipMatches.map((s, i) => row({ kind: 'snippet', snippet: s }, i))}
                  {histMatches.length > 0 && (
                    <div className="palette-section">
                      <span>{scopeLabel} history</span>
                      <span className="palette-frec-tag" title="Sorted by recency × frequency">
                        frecency
                      </span>
                    </div>
                  )}
                  {histMatches.map((h, i) =>
                    row(
                      { kind: 'history', command: h.command, count: h.count },
                      snipMatches.length + i
                    )
                  )}
                </>
              )}
            </div>
            {error && <div className="palette-error">{error}</div>}
            <div className="palette-foot">
              <span>
                <kbd>↵</kbd> Run
              </span>
              <span>
                <kbd>⇧↵</kbd> Insert
              </span>
              <span>
                <kbd>↑↓</kbd> Navigate
              </span>
              <span>
                <kbd>Esc</kbd> Close
              </span>
            </div>
          </>
        ) : (
          <div className="palette-params">
            <div className="palette-name">{chosen.name}</div>
            <div className="palette-cmd sn-mono">{applyPlaceholders(chosen.command, values)}</div>
            <div className="palette-grid">
              {placeholders.map((name, i) => (
                <label key={name}>
                  {name}
                  <input
                    ref={i === 0 ? firstParamRef : undefined}
                    value={values[name] ?? ''}
                    onChange={(e) => setValues((v) => ({ ...v, [name]: e.target.value }))}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        submitParams(!e.shiftKey)
                      } else if (e.key === 'Escape') {
                        e.preventDefault()
                        setChosen(null)
                      }
                    }}
                  />
                </label>
              ))}
            </div>
            {error && <div className="palette-error">{error}</div>}
            <div className="palette-actions">
              <button
                className="ghost"
                onClick={clearRecentValues}
                disabled={!canClearCache}
                title="Erase the cached placeholder values for this palette session"
              >
                Clear recent values
              </button>
              <span className="spacer" />
              <button onClick={() => setChosen(null)}>Back</button>
              <button onClick={() => submitParams(false)}>Insert</button>
              <button className="primary" onClick={() => submitParams(true)}>
                Run
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
