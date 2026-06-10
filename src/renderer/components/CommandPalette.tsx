import { useEffect, useMemo, useRef, useState } from 'react'
import type { HistoryResult, Snippet } from '@shared/types'
import { activeSession, runInActive } from '../lib/input'
import { applyPlaceholders, extractPlaceholders } from '../lib/snippets'

// Fuzzy-ish filter: every whitespace-separated term must appear (case-insensitive).
function termsOf(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean)
}
function matches(s: Snippet, terms: string[]): boolean {
  const hay = `${s.name} ${s.command} ${s.description ?? ''} ${(s.tags ?? []).join(' ')}`.toLowerCase()
  return terms.every((t) => hay.includes(t))
}

// One selectable palette entry: a saved snippet, or a command from history.
type Item =
  | { kind: 'snippet'; snippet: Snippet }
  | { kind: 'history'; command: string; count?: number }

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
  const [histSort, setHistSort] = useState<'recent' | 'frequent'>('recent')
  const [scopeLabel, setScopeLabel] = useState('Local')
  const [saved, setSaved] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState('')
  const [sel, setSel] = useState(0)
  const [chosen, setChosen] = useState<Snippet | null>(null)
  const [values, setValues] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const firstParamRef = useRef<HTMLInputElement>(null)

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
  }, [])

  // Snippets that match the query (named, parameterizable saved commands).
  const snipMatches = useMemo(() => {
    const terms = termsOf(query)
    return snippets.filter((s) => matches(s, terms))
  }, [snippets, query])

  // History commands that match — excluding any already saved as a snippet (they
  // show in the Snippets section instead), capped so the list stays scannable.
  const histMatches = useMemo(() => {
    if (!hist) return [] as { command: string; count?: number }[]
    const terms = termsOf(query)
    const snippetCmds = new Set(snippets.map((s) => s.command))
    const base =
      histSort === 'frequent'
        ? hist.frequent.map((f) => ({ command: f.command, count: f.count }))
        : hist.recent.map((c) => ({ command: c }) as { command: string; count?: number })
    return base
      .filter((h) => !snippetCmds.has(h.command))
      .filter((h) => terms.every((t) => h.command.toLowerCase().includes(t)))
      .slice(0, query ? 60 : 12)
  }, [hist, histSort, snippets, query])

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
    setValues({})
    setError(null)
    setTimeout(() => firstParamRef.current?.focus(), 0)
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
    send(applyPlaceholders(chosen.command, values), execute)
  }

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
    return (
      <div
        key={`h-${item.command}`}
        className={`palette-row ${selected ? 'sel' : ''}`}
        onMouseEnter={() => setSel(idx)}
        onClick={() => activate(item, true)}
      >
        <div className="palette-histrow">
          <span className="palette-cmd sn-mono">{item.command}</span>
          {typeof item.count === 'number' && item.count > 1 && (
            <span className="palette-count" title={`run ${item.count} times`}>
              {item.count}×
            </span>
          )}
          <button
            className="palette-save"
            title={saved.has(item.command) ? 'Saved as snippet' : 'Save as snippet'}
            onClick={(e) => {
              e.stopPropagation()
              if (!saved.has(item.command)) void saveAsSnippet(item.command)
            }}
          >
            {saved.has(item.command) ? '✓' : '+'}
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
                      <span className="spacer" />
                      <button
                        className={`palette-seg ${histSort === 'recent' ? 'on' : ''}`}
                        onClick={() => setHistSort('recent')}
                      >
                        Recent
                      </button>
                      <button
                        className={`palette-seg ${histSort === 'frequent' ? 'on' : ''}`}
                        onClick={() => setHistSort('frequent')}
                      >
                        Frequent
                      </button>
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
