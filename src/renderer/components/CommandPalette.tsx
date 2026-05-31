import { useEffect, useMemo, useRef, useState } from 'react'
import type { Snippet } from '@shared/types'
import { runInActive } from '../lib/input'
import { applyPlaceholders, extractPlaceholders } from '../lib/snippets'

// Fuzzy-ish filter: every whitespace-separated term must appear (case-insensitive)
// somewhere in the snippet's name, command, description, or tags.
function matches(s: Snippet, query: string): boolean {
  const hay =
    `${s.name} ${s.command} ${s.description ?? ''} ${(s.tags ?? []).join(' ')}`.toLowerCase()
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((t) => hay.includes(t))
}

export default function CommandPalette({
  onRun,
  onClose
}: {
  /** Called right before a command is sent, so the host can switch to the terminals view. */
  onRun: () => void
  onClose: () => void
}) {
  const [snippets, setSnippets] = useState<Snippet[]>([])
  const [query, setQuery] = useState('')
  const [sel, setSel] = useState(0)
  const [chosen, setChosen] = useState<Snippet | null>(null)
  const [values, setValues] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const firstParamRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    window.devterm.snippets.list().then(setSnippets)
    inputRef.current?.focus()
  }, [])

  const filtered = useMemo(() => snippets.filter((s) => matches(s, query)), [snippets, query])
  // Keep the selection in range as the filtered list changes.
  useEffect(() => {
    setSel((i) => Math.max(0, Math.min(i, filtered.length - 1)))
  }, [filtered.length])

  // Send a fully-resolved command, or close on failure with a message.
  const send = (command: string, execute: boolean) => {
    onRun()
    if (runInActive(command, execute)) onClose()
    else setError('No active terminal to send the command to.')
  }

  // Pick a snippet: send it directly, or open the placeholder form first.
  const choose = (s: Snippet | undefined, execute: boolean) => {
    if (!s) return
    if (extractPlaceholders(s.command).length === 0) {
      send(s.command, execute)
      return
    }
    setChosen(s)
    setValues({})
    setError(null)
    setTimeout(() => firstParamRef.current?.focus(), 0)
  }

  const submitParams = (execute: boolean) => {
    if (!chosen) return
    send(applyPlaceholders(chosen.command, values), execute)
  }

  const onListKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSel((i) => Math.min(i + 1, filtered.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSel((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      choose(filtered[sel], !e.shiftKey)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  const placeholders = chosen ? extractPlaceholders(chosen.command) : []

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        {!chosen ? (
          <>
            <input
              ref={inputRef}
              className="palette-input"
              value={query}
              placeholder="Run a snippet…"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onListKey}
            />
            <div className="palette-list">
              {filtered.length === 0 ? (
                <div className="palette-empty">
                  {snippets.length === 0
                    ? 'No snippets yet — add one in the Snippets tab.'
                    : 'No matching snippets.'}
                </div>
              ) : (
                filtered.map((s, i) => (
                  <div
                    key={s.id}
                    className={`palette-row ${i === sel ? 'sel' : ''}`}
                    onMouseEnter={() => setSel(i)}
                    onClick={() => choose(s, true)}
                  >
                    <div className="palette-name">{s.name}</div>
                    <div className="palette-cmd sn-mono">{s.command}</div>
                  </div>
                ))
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
