import { useCallback, useEffect, useState } from 'react'
import type { GitLogEntry, GitShowResult } from '@shared/types'
import type { GitScope } from './GitPanel'
import GitGraphView from './GitGraphView'
import { IconGraph, IconList } from './GitIcons'

/**
 * The Log tab — newest-first commit history. Each row shows the short SHA,
 * author, relative time, and the first line of the subject. Click a row to
 * expand a detail view: subject + body, files changed, and the patch.
 *
 * Two views: graph (default, VSCode Git Graph-style lanes) and a flat list.
 * The choice is local to the panel for now — it's a small preference that
 * doesn't justify a settings field.
 */

const RELOAD_MS = 30_000

type LogView = 'graph' | 'list'

export default function GitLogPanel({ scope }: { scope: GitScope }) {
  const [entries, setEntries] = useState<GitLogEntry[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [show, setShow] = useState<GitShowResult | null | undefined>(undefined)
  const [ref, setRef] = useState<string>('')
  const [busy, setBusy] = useState(false)
  const [view, setView] = useState<LogView>('graph')

  const reload = useCallback(() => {
    setBusy(true)
    void window.devterm.git
      .log({ sessionId: scope.sessionId, path: scope.path, ref: ref || undefined, maxCount: 200 })
      .then((e) => setEntries(e))
      .finally(() => setBusy(false))
  }, [scope.sessionId, scope.path, ref])

  useEffect(() => {
    reload()
  }, [reload])

  // Background auto-refresh while the panel is visible.
  useEffect(() => {
    const id = setInterval(reload, RELOAD_MS)
    return () => clearInterval(id)
  }, [reload])

  // Lazy-fetch the detail view for the selected SHA.
  useEffect(() => {
    if (!selected) {
      setShow(undefined)
      return
    }
    let cancelled = false
    setShow(undefined)
    void window.devterm.git
      .show({ sessionId: scope.sessionId, path: scope.path, sha: selected })
      .then((s) => {
        if (!cancelled) setShow(s ?? null)
      })
    return () => {
      cancelled = true
    }
  }, [selected, scope.sessionId, scope.path])

  const handleSelect = (sha: string) => setSelected(selected === sha ? null : sha)

  return (
    <div className="git-log">
      <div className="git-log-toolbar">
        <input
          className="git-input small"
          value={ref}
          onChange={(e) => setRef(e.target.value)}
          placeholder="HEAD"
          spellCheck={false}
          title="Ref to start from (e.g. origin/main, v1.0.0, abc1234)"
        />
        <button className="git-mini" onClick={reload} disabled={busy}>
          Refresh
        </button>
        <span className="git-log-toolbar-spacer" />
        <div className="git-log-view-toggle" role="group" aria-label="Log view">
          <button
            type="button"
            className={`git-log-view-btn ${view === 'graph' ? 'on' : ''}`}
            onClick={() => setView('graph')}
            title="Graph view"
            aria-label="Graph view"
            aria-pressed={view === 'graph'}
          >
            <IconGraph size={13} />
          </button>
          <button
            type="button"
            className={`git-log-view-btn ${view === 'list' ? 'on' : ''}`}
            onClick={() => setView('list')}
            title="List view"
            aria-label="List view"
            aria-pressed={view === 'list'}
          >
            <IconList size={13} />
          </button>
        </div>
      </div>
      {entries === null && <div className="git-loading">loading…</div>}
      {entries !== null && entries.length === 0 && <div className="git-empty">no commits</div>}
      {entries && entries.length > 0 && view === 'graph' && (
        <GitGraphView
          entries={entries}
          selected={selected}
          onSelect={handleSelect}
          formatRel={formatRel}
        />
      )}
      {entries && entries.length > 0 && view === 'list' && (
        <div className="git-log-list">
          {entries.map((e) => (
            <LogRow
              key={e.sha}
              entry={e}
              selected={selected === e.sha}
              onSelect={() => handleSelect(e.sha)}
            />
          ))}
        </div>
      )}
      {show && <ShowDetail show={show} />}
    </div>
  )
}

function LogRow({
  entry,
  selected,
  onSelect
}: {
  entry: GitLogEntry
  selected: boolean
  onSelect: () => void
}) {
  const refs = entry.refs.filter((r) => r && r !== 'HEAD')
  return (
    <div className={`git-log-row ${selected ? 'sel' : ''}`} onClick={onSelect}>
      <div className="git-log-row-main">
        <span className="git-sha" title={entry.sha}>
          {entry.shortSha}
        </span>
        <span className="git-log-subject">{entry.subject || '(no subject)'}</span>
      </div>
      <div className="git-log-row-meta">
        <span className="git-author">{entry.authorName}</span>
        <span className="git-time" title={entry.authorDate}>
          {formatRel(entry.authorDate)}
        </span>
        {refs.length > 0 && <span className="git-refs">{refs.join(' · ')}</span>}
      </div>
    </div>
  )
}

function ShowDetail({ show }: { show: GitShowResult }) {
  return (
    <div className="git-show-detail">
      <div className="git-show-header">
        <span className="git-sha">{show.shortSha}</span>
        <span className="git-show-subject">{show.subject}</span>
      </div>
      {show.body && <pre className="git-show-body">{show.body}</pre>}
      {show.files.length > 0 && (
        <div className="git-show-files">
          {show.files.map((f) => (
            <div key={f.path} className="git-show-file">
              <span className={`git-badge git-${f.status.toLowerCase()}`}>{f.status}</span>
              <span className="git-row-name">{f.path}</span>
              <span className="git-meta">
                +{f.additions} -{f.deletions}
              </span>
            </div>
          ))}
        </div>
      )}
      {show.patch && (
        <pre className="git-diff-pre">{show.patch}</pre>
      )}
    </div>
  )
}

/** Approximate "5 minutes ago" rendering without bringing in a date lib. */
function formatRel(iso: string): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return iso
  const sec = Math.max(0, (Date.now() - t) / 1000)
  if (sec < 60) return 'just now'
  const min = sec / 60
  if (min < 60) return `${Math.floor(min)}m ago`
  const hr = min / 60
  if (hr < 24) return `${Math.floor(hr)}h ago`
  const day = hr / 24
  if (day < 30) return `${Math.floor(day)}d ago`
  const mon = day / 30
  if (mon < 12) return `${Math.floor(mon)}mo ago`
  return `${Math.floor(mon / 12)}y ago`
}
