import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  HistoryResult,
  SavedConnection,
  Snippet,
  Workspace,
  WorkspaceItem
} from '@shared/types'
import { activeSession, runInActive } from '../../lib/input'
import { openTmuxPicker } from '../../lib/terms'
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
  snippetCommandSet
} from '../../lib/history-frecency'
import { scoreTerms } from '../../lib/fuzzy'
import { useEscapeKey } from '../../lib/useEscapeKey'
import { useSessions } from '../../store/sessions'
import { useLayout } from '../../store/layout'
import { toLiveSnapshot } from '../../lib/workspace'
import { IconGroup, IconGrid, IconPalette, IconRemote, IconTerminals } from '../common/Icons'

type Category = 'all' | 'actions' | 'snippets' | 'connections' | 'workspaces' | 'history'

type PaletteItem =
  | { kind: 'snippet'; snippet: Snippet; score: number }
  | { kind: 'connection'; conn: SavedConnection; score: number }
  | { kind: 'workspace'; ws: Workspace; score: number }
  | { kind: 'history'; command: string; count: number; score: number }
  | { kind: 'action'; id: string; title: string; subtitle: string; score: number }

const CATEGORIES: { id: Category; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'actions', label: 'Actions' },
  { id: 'snippets', label: 'Snippets' },
  { id: 'connections', label: 'Connections' },
  { id: 'workspaces', label: 'Workspaces' },
  { id: 'history', label: 'History' }
]

function snippetTarget(s: Snippet): string {
  return `${s.name} ${s.command} ${s.description ?? ''} ${(s.tags ?? []).join(' ')}`
}

function connectionTarget(c: SavedConnection): string {
  return `${c.name} ${c.host} ${c.username} ${c.port ?? ''}`
}

function workspaceItemLabel(it: WorkspaceItem, connName: (id?: string) => string): string {
  return it.kind === 'local' ? (it.title ?? 'Local') : connName(it.connectionId)
}

function workspaceTarget(ws: Workspace, connName: (id?: string) => string): string {
  return `${ws.name} ${ws.description ?? ''} ${ws.items.map((it) => workspaceItemLabel(it, connName)).join(' ')}`
}

export default function CommandPalette({
  onRun,
  onClose,
  onCreateGrid
}: {
  /** Called right before a command is sent, so the host can switch to the terminals view. */
  onRun: () => void
  onClose: () => void
  /** Open the Create Grid modal (optional action). */
  onCreateGrid?: () => void
}) {
  const [snippets, setSnippets] = useState<Snippet[]>([])
  const [hist, setHist] = useState<HistoryResult | null>(null)
  const [scopeLabel, setScopeLabel] = useState('Local')
  const [connections, setConnections] = useState<SavedConnection[]>([])
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [asyncReady, setAsyncReady] = useState(false)
  const [category, setCategory] = useState<Category>('all')

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
    const s = activeSession()
    const remote = s?.kind === 'remote'
    setScopeLabel(remote ? 'Remote' : 'Local')

    const load = async () => {
      const [snipList, histResult, connList, wsList] = await Promise.all([
        window.devterm.snippets.list(),
        window.devterm.history
          .query(remote ? { scope: 'remote', sessionId: s!.id } : { scope: 'local' })
          .catch(() => ({ recent: [], frequent: [] }) as HistoryResult),
        window.devterm.connections.list().catch(() => [] as SavedConnection[]),
        window.devterm.workspaces.list().catch(() => [] as Workspace[])
      ])
      setSnippets(snipList)
      setHist(histResult)
      setConnections(connList)
      setWorkspaces(wsList)
    }
    void load().finally(() => setAsyncReady(true))

    inputRef.current?.focus()
    return () => {
      if (focusTimerRef.current) {
        clearTimeout(focusTimerRef.current)
        focusTimerRef.current = null
      }
    }
  }, [])

  // Window-level Esc-to-close: the input's own key handling only fires while
  // the input is focused (e.g. clicking "+ save as snippet" moves focus away).
  useEscapeKey(onClose)

  const connName = useCallback(
    (id?: string) => (id && connections.find((c) => c.id === id)?.name) || '(deleted connection)',
    [connections]
  )

  const queryTrimmed = query.trim()

  const snippetItems = useMemo<PaletteItem[]>(() => {
    if (queryTrimmed) {
      return (
        snippets
          .map((s) => {
            const scored = scoreTerms(snippetTarget(s), queryTrimmed)
            return scored ? { kind: 'snippet' as const, snippet: s, score: scored.score } : null
          })
          .filter(Boolean) as Extract<PaletteItem, { kind: 'snippet' }>[]
      ).sort((a, b) => b.score - a.score || a.snippet.name.localeCompare(b.snippet.name))
    }
    return snippets
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((s) => ({ kind: 'snippet' as const, snippet: s, score: 0 }))
  }, [snippets, queryTrimmed])

  const connectionItems = useMemo<PaletteItem[]>(() => {
    if (queryTrimmed) {
      return (
        connections
          .map((c) => {
            const scored = scoreTerms(connectionTarget(c), queryTrimmed)
            return scored ? { kind: 'connection' as const, conn: c, score: scored.score } : null
          })
          .filter(Boolean) as Extract<PaletteItem, { kind: 'connection' }>[]
      ).sort((a, b) => b.score - a.score || a.conn.name.localeCompare(b.conn.name))
    }
    return connections
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((c) => ({ kind: 'connection' as const, conn: c, score: 0 }))
  }, [connections, queryTrimmed])

  const workspaceItems = useMemo<PaletteItem[]>(() => {
    if (queryTrimmed) {
      return (
        workspaces
          .map((ws) => {
            const scored = scoreTerms(workspaceTarget(ws, connName), queryTrimmed)
            return scored ? { kind: 'workspace' as const, ws, score: scored.score } : null
          })
          .filter(Boolean) as Extract<PaletteItem, { kind: 'workspace' }>[]
      ).sort((a, b) => b.score - a.score || a.ws.name.localeCompare(b.ws.name))
    }
    return workspaces
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((ws) => ({ kind: 'workspace' as const, ws, score: 0 }))
  }, [workspaces, queryTrimmed, connName])

  const historyItems = useMemo<PaletteItem[]>(() => {
    const frec = buildFrecency(hist)
    const snippetCmds = snippetCommandSet(snippets)
    if (queryTrimmed) {
      return (
        frec
          .filter((e) => !snippetCmds.has(normalizeForDedupe(e.command)))
          .map((e) => {
            const scored = scoreTerms(e.command, queryTrimmed)
            return scored
              ? {
                  kind: 'history' as const,
                  command: e.command,
                  count: e.count,
                  score: scored.score
                }
              : null
          })
          .filter(Boolean) as Extract<PaletteItem, { kind: 'history' }>[]
      ).sort((a, b) => b.score - a.score || a.command.localeCompare(b.command))
    }
    return filterHistory(frec, snippetCmds, '', 30).map((e) => ({
      kind: 'history' as const,
      command: e.command,
      count: e.count,
      score: e.score
    }))
  }, [hist, snippets, queryTrimmed])

  const actionItems = useMemo<PaletteItem[]>(() => {
    const actions = [
      {
        kind: 'action' as const,
        id: 'grid',
        title: 'Create terminal grid…',
        subtitle: 'Open rows × columns of local shells in a new group',
        score: 0
      },
      {
        kind: 'action' as const,
        id: 'tmux',
        title: 'tmux sessions…',
        subtitle: 'Preview, attach, or kill tmux sessions on this remote',
        score: 0
      }
    ]
    if (!queryTrimmed) return actions
    return actions
      .map((a) => {
        const extra = a.id === 'grid' ? ' grid split 2x2 3x3 new grid' : ' tmux session attach kill'
        const target = `${a.title} ${a.subtitle}${extra}`
        const scored = scoreTerms(target, queryTrimmed)
        return scored ? { ...a, score: scored.score } : null
      })
      .filter(Boolean) as Extract<PaletteItem, { kind: 'action' }>[]
  }, [queryTrimmed])

  // The union of "commands already saved as a snippet (any name)" — for the
  // ✓ indicator.
  const savedAsSnippetCmds = useMemo(() => {
    const out = new Set<string>()
    for (const s of snippets) out.add(normalizeForDedupe(s.command))
    return out
  }, [snippets])

  const counts = useMemo(
    () => ({
      all:
        actionItems.length +
        snippetItems.length +
        connectionItems.length +
        workspaceItems.length +
        historyItems.length,
      actions: actionItems.length,
      snippets: snippetItems.length,
      connections: connectionItems.length,
      workspaces: workspaceItems.length,
      history: historyItems.length
    }),
    [actionItems, snippetItems, connectionItems, workspaceItems, historyItems]
  )

  const sections = useMemo(() => {
    const cap = category === 'all' ? 8 : Infinity
    const out: { title: string; items: PaletteItem[] }[] = []
    if ((category === 'all' || category === 'actions') && actionItems.length) {
      out.push({ title: 'Actions', items: actionItems.slice(0, cap) })
    }
    if ((category === 'all' || category === 'snippets') && snippetItems.length) {
      out.push({ title: 'Snippets', items: snippetItems.slice(0, cap) })
    }
    if ((category === 'all' || category === 'connections') && connectionItems.length) {
      out.push({ title: 'Connections', items: connectionItems.slice(0, cap) })
    }
    if ((category === 'all' || category === 'workspaces') && workspaceItems.length) {
      out.push({ title: 'Workspaces', items: workspaceItems.slice(0, cap) })
    }
    if ((category === 'all' || category === 'history') && historyItems.length) {
      out.push({
        title: category === 'history' ? `${scopeLabel} history` : 'History',
        items: historyItems.slice(0, category === 'all' ? 12 : Infinity)
      })
    }
    return out
  }, [
    category,
    actionItems,
    snippetItems,
    connectionItems,
    workspaceItems,
    historyItems,
    scopeLabel
  ])

  const flatItems = useMemo(() => sections.flatMap((s) => s.items), [sections])

  // Keep the selection in range as the list changes.
  useEffect(() => {
    setSel((i) => Math.max(0, Math.min(i, flatItems.length - 1)))
  }, [flatItems.length])

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

  const launchWorkspace = async (ws: Workspace) => {
    onRun()
    const { addLocal, connectSsh } = useSessions.getState()
    const groupId = `ws-${ws.id}-${Date.now()}`
    const layout = useLayout.getState()
    layout.ensureGroup(groupId, ws.name)
    layout.flagGroupLaunched(groupId, ws.id)

    const map = new Map<string, string>()
    await Promise.all(
      ws.items.map(async (it) => {
        if (it.kind === 'local') {
          map.set(it.id, addLocal({ cwd: it.cwd, groupId }))
          return
        }
        const c = connections.find((x) => x.id === it.connectionId)
        if (!c) return
        const { id: _id, name: _name, ...profile } = c
        const sid = await connectSsh(profile, {
          connectionId: it.connectionId,
          startCwd: it.cwd,
          groupId
        })
        if (sid) map.set(it.id, sid)
      })
    )
    const snap = ws.layout ? toLiveSnapshot(ws.layout, map) : null
    setTimeout(() => {
      const layout2 = useLayout.getState()
      if (snap) layout2.restoreGroup(groupId, ws.name, snap)
      else layout2.setActiveGroup(groupId)
    }, 80)
    void window.devterm.workspaces.recordLaunch(ws.id).catch(() => undefined)
  }

  const activate = (item: PaletteItem | undefined, execute: boolean) => {
    if (!item) return
    if (item.kind === 'snippet') choose(item.snippet, execute)
    else if (item.kind === 'history') send(item.command, execute)
    else if (item.kind === 'connection') {
      onRun()
      const { id: _id, name: _name, ...profile } = item.conn
      void useSessions.getState().connectSsh(profile, { connectionId: item.conn.id })
      onClose()
    } else if (item.kind === 'workspace') {
      void launchWorkspace(item.ws)
      onClose()
    } else if (item.kind === 'action') {
      onRun()
      if (item.id === 'grid') onCreateGrid?.()
      if (item.id === 'tmux') {
        const sid = useSessions.getState().activeId
        if (sid) openTmuxPicker(sid)
      }
      onClose()
    }
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

  const nextCategory = (dir: 1 | -1) => {
    const idx = CATEGORIES.findIndex((c) => c.id === category)
    setCategory(CATEGORIES[(idx + dir + CATEGORIES.length) % CATEGORIES.length].id)
    setSel(0)
  }

  const onListKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSel((i) => Math.min(i + 1, flatItems.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSel((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      activate(flatItems[sel], !e.shiftKey)
    } else if (e.key === 'Tab') {
      e.preventDefault()
      nextCategory(e.shiftKey ? -1 : 1)
    }
  }

  const placeholders = chosen ? extractPlaceholders(chosen.command) : []
  const hasHistory = !!hist && (hist.recent.length > 0 || hist.frequent.length > 0)
  const canClearCache = placeholders.length > 0
  const isSavedHistory = (cmd: string) =>
    saved.has(cmd) || savedAsSnippetCmds.has(normalizeForDedupe(cmd))

  const actionHint = (kind: PaletteItem['kind']) => {
    switch (kind) {
      case 'connection':
        return 'Connect'
      case 'workspace':
        return 'Launch'
      case 'action':
        return 'Open'
      default:
        return 'Run'
    }
  }

  const rowIcon = (kind: PaletteItem['kind']) => {
    switch (kind) {
      case 'snippet':
        return <IconPalette size={16} />
      case 'connection':
        return <IconRemote size={16} />
      case 'workspace':
        return <IconGroup size={16} />
      case 'history':
        return <IconTerminals size={16} />
      case 'action':
        return <IconGrid size={16} />
    }
  }

  const rowContent = (item: PaletteItem) => {
    if (item.kind === 'snippet') {
      return {
        title: item.snippet.name,
        subtitle: item.snippet.command,
        mono: true
      }
    }
    if (item.kind === 'connection') {
      const c = item.conn
      return {
        title: c.name,
        subtitle: `${c.username}@${c.host}${c.port && c.port !== 22 ? `:${c.port}` : ''}`,
        mono: false
      }
    }
    if (item.kind === 'workspace') {
      const ws = item.ws
      const local = ws.items.filter((i) => i.kind === 'local').length
      const remote = ws.items.length - local
      const parts: string[] = []
      if (remote) parts.push(`${remote} remote`)
      if (local) parts.push(`${local} local`)
      return {
        title: ws.name,
        subtitle: ws.description ? `${ws.description} · ${parts.join(' · ')}` : parts.join(' · '),
        mono: false
      }
    }
    if (item.kind === 'action') {
      return { title: item.title, subtitle: item.subtitle, mono: false }
    }
    const savedAlready = isSavedHistory(item.command)
    return {
      title: item.command,
      subtitle: `${scopeLabel}${item.count > 1 ? ` · run ${item.count} times` : ''}${savedAlready ? ' · saved as snippet' : ''}`,
      mono: true
    }
  }

  const row = (item: PaletteItem, idx: number) => {
    const selected = idx === sel
    const content = rowContent(item)
    const isHistory = item.kind === 'history'
    const savedAlready = isHistory && isSavedHistory(item.command)
    const key =
      item.kind === 'history'
        ? item.command
        : item.kind === 'snippet'
          ? item.snippet.id
          : item.kind === 'connection'
            ? item.conn.id
            : item.kind === 'workspace'
              ? item.ws.id
              : item.id
    return (
      <div
        key={`${item.kind}-${key}`}
        className={`palette-row ${selected ? 'sel' : ''}`}
        title={isHistory ? item.command : undefined}
        onMouseEnter={() => setSel(idx)}
        onClick={() => activate(item, true)}
      >
        <span className="palette-row-icon">{rowIcon(item.kind)}</span>
        <div className="palette-row-main">
          <div className="palette-name">{content.title}</div>
          <div className={`palette-row-sub ${content.mono ? 'sn-mono' : ''}`}>
            {content.subtitle}
          </div>
        </div>
        <div className="palette-row-hint">
          {isHistory ? (
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
          ) : (
            <span>
              <kbd>↵</kbd> {actionHint(item.kind)}
            </span>
          )}
        </div>
      </div>
    )
  }

  const isEmpty = flatItems.length === 0
  const emptyMessage = !asyncReady
    ? 'Loading connections and workspaces…'
    : snippets.length === 0 && !hasHistory && connections.length === 0 && workspaces.length === 0
      ? 'No snippets, connections, workspaces, or command history yet — run some commands or add items.'
      : 'No matches.'

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onClick={(e) => e.stopPropagation()}
      >
        {!chosen ? (
          <>
            <input
              ref={inputRef}
              className="palette-input"
              value={query}
              placeholder="Run a snippet, connect, launch a workspace, or search history…"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onListKey}
            />
            <div className="palette-tabs">
              {CATEGORIES.map((c) => (
                <button
                  key={c.id}
                  className={`palette-tab ${category === c.id ? 'active' : ''}`}
                  onClick={() => {
                    setCategory(c.id)
                    setSel(0)
                    inputRef.current?.focus()
                  }}
                >
                  {c.label}
                  {counts[c.id] > 0 && <span className="count">{counts[c.id]}</span>}
                </button>
              ))}
            </div>
            <div className="palette-list">
              {isEmpty ? (
                <div className="palette-empty">{emptyMessage}</div>
              ) : (
                sections.map((section, sidx) => {
                  let offset = 0
                  for (let i = 0; i < sidx; i++) offset += sections[i].items.length
                  return (
                    <div key={section.title}>
                      <div className="palette-section">
                        <span>{section.title}</span>
                        {section.title.toLowerCase().includes('history') && (
                          <span className="palette-frec-tag" title="Sorted by recency × frequency">
                            frecency
                          </span>
                        )}
                      </div>
                      {section.items.map((item, i) => row(item, offset + i))}
                    </div>
                  )
                })
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
                <kbd>Tab</kbd> Switch category
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
                        // Keep Esc meaning "back to the list" in the params
                        // form — don't let it reach the window-level close.
                        e.stopPropagation()
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
                type="button"
                className="ghost"
                onClick={clearRecentValues}
                disabled={!canClearCache}
                title="Erase the cached placeholder values for this palette session"
              >
                Clear recent values
              </button>
              <span className="spacer" />
              <button type="button" className="ghost" onClick={() => setChosen(null)}>
                Back
              </button>
              <button type="button" className="ghost" onClick={() => submitParams(false)}>
                Insert
              </button>
              <button type="button" className="primary" onClick={() => submitParams(true)}>
                Run
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
