import { useEffect, useState } from 'react'
import type { GitCommandResult, GitRemote } from '@shared/types'
import type { GitScope } from './GitPanel'
import { IconPlus, IconTrash } from '../common/Icons'
import { IconFetch, IconPull, IconPush } from './GitIcons'

/**
 * The Remotes tab — list of git remotes with their URLs and per-row
 * fetch/pull/push actions. Adding a remote opens NewRemoteModal; removing
 * uses git's built-in `remote remove` (no confirmation needed beyond the
 * undo of re-adding it).
 */
export default function GitRemotesPanel({
  scope,
  onNewRemote,
  run,
  onError: _onError
}: {
  scope: GitScope
  onNewRemote: () => void
  run: (
    op: () => Promise<GitCommandResult>,
    onError?: (r: GitCommandResult) => void
  ) => Promise<GitCommandResult | null>
  onError: (msg: string | null) => void
}) {
  const [remotes, setRemotes] = useState<GitRemote[] | null>(null)
  const [tick, setTick] = useState(0)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void window.devterm.git
      .remotes({ sessionId: scope.sessionId, path: scope.path })
      .then(setRemotes)
  }, [scope.path, scope.sessionId, tick])

  if (remotes === null) return <div className="git-loading">loading…</div>

  return (
    <div className="git-section">
      <div className="git-section-head">
        <span className="git-section-title">Remotes</span>
        <span className="git-section-count">{remotes.length}</span>
        <span className="spacer" />
        <button className="git-mini" onClick={onNewRemote}>
          <IconPlus size={12} />
          <span>Add</span>
        </button>
      </div>
      <div className="git-section-body">
        {remotes.length === 0 && (
          <div className="git-row-empty">
            no remotes
            <button className="git-mini" onClick={onNewRemote} style={{ marginLeft: 8 }}>
              <IconPlus size={12} /> <span>Add remote</span>
            </button>
          </div>
        )}
        {remotes.map((r) => (
          <div key={r.name} className="git-remote-row">
            <span className="git-remote-name">{r.name}</span>
            <span className="git-remote-url" title={r.fetchUrl || r.pushUrl}>
              {r.fetchUrl || r.pushUrl}
            </span>
            <span className="spacer" />
            <button
              className="git-icon-btn small"
              disabled={busy}
              onClick={async () => {
                setBusy(true)
                await run(() => window.devterm.git.fetch({ ...scope, remote: r.name, prune: true }))
                setBusy(false)
                setTick((t) => t + 1)
              }}
              title="Fetch"
              aria-label="Fetch"
            >
              <IconFetch size={12} />
            </button>
            <button
              className="git-icon-btn small"
              disabled={busy}
              onClick={async () => {
                setBusy(true)
                await run(() => window.devterm.git.pull({ ...scope, remote: r.name }))
                setBusy(false)
                setTick((t) => t + 1)
              }}
              title="Pull"
              aria-label="Pull"
            >
              <IconPull size={12} />
            </button>
            <button
              className="git-icon-btn small"
              disabled={busy}
              onClick={async () => {
                setBusy(true)
                await run(() => window.devterm.git.push({ ...scope, remote: r.name }))
                setBusy(false)
                setTick((t) => t + 1)
              }}
              title="Push"
              aria-label="Push"
            >
              <IconPush size={12} />
            </button>
            <button
              className="git-icon-btn small danger"
              disabled={busy}
              onClick={async () => {
                if (!window.confirm(`Remove remote "${r.name}"?`)) return
                setBusy(true)
                await run(() => window.devterm.git.removeRemote({ ...scope, name: r.name }))
                setBusy(false)
                setTick((t) => t + 1)
              }}
              title="Remove remote"
              aria-label="Remove"
            >
              <IconTrash size={12} />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
