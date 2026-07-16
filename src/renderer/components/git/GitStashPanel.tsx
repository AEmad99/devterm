import { useCallback, useEffect, useState } from 'react'
import type { GitCommandResult, GitStashEntry } from '@shared/types'
import type { GitScope } from './GitPanel'
import ConfirmDialog from '../common/ConfirmDialog'

/**
 * The Stash tab — list of stash entries with Apply / Pop / Drop actions.
 * Apply = land the changes back without removing the entry; Pop = apply and
 * drop; Drop = discard. Git's `stash pop` requires the working tree to be
 * clean (same as apply) — the panel surfaces git's stderr so the user sees
 * the conflict.
 */
export default function GitStashPanel({
  scope,
  run,
  onError: _onError
}: {
  scope: GitScope
  run: (
    op: () => Promise<GitCommandResult>,
    onError?: (r: GitCommandResult) => void
  ) => Promise<GitCommandResult | null>
  onError: (msg: string | null) => void
}) {
  const [items, setItems] = useState<GitStashEntry[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [tick, setTick] = useState(0)
  // Stash ref awaiting a drop confirmation.
  const [confirmDrop, setConfirmDrop] = useState<string | null>(null)

  const reload = useCallback(() => {
    void window.devterm.git.stash({ sessionId: scope.sessionId, path: scope.path }).then(setItems)
  }, [scope.path, scope.sessionId])

  useEffect(() => {
    reload()
  }, [reload, tick])

  const dropStash = async (ref: string) => {
    setBusy(true)
    await run(() => window.devterm.git.stashDrop({ ...scope, ref }))
    setBusy(false)
    setTick((t) => t + 1)
  }

  if (items === null) return <div className="git-loading">loading…</div>
  if (items.length === 0) return <div className="git-empty">no stashes</div>

  return (
    <div className="git-stash">
      <div className="git-section">
        <div className="git-section-head">
          <span className="git-section-title">Stashes</span>
          <span className="git-section-count">{items.length}</span>
        </div>
        <div className="git-section-body">
          {items.map((s) => (
            <div key={s.ref} className="git-stash-row">
              <div className="git-stash-meta">
                <span className="git-stash-ref">{s.ref}</span>
                <span className="git-stash-msg">{s.message}</span>
                {s.branch && <span className="git-meta">on {s.branch}</span>}
              </div>
              <div className="git-stash-actions">
                <button
                  className="git-mini"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true)
                    await run(() => window.devterm.git.stashApply({ ...scope, ref: s.ref }))
                    setBusy(false)
                    setTick((t) => t + 1)
                  }}
                >
                  Apply
                </button>
                <button
                  className="git-mini"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true)
                    await run(() => window.devterm.git.stashPop({ ...scope, ref: s.ref }))
                    setBusy(false)
                    setTick((t) => t + 1)
                  }}
                >
                  Pop
                </button>
                <button
                  className="git-mini danger"
                  disabled={busy}
                  onClick={() => setConfirmDrop(s.ref)}
                >
                  Drop
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {confirmDrop && (
        <ConfirmDialog
          open
          title="Drop stash?"
          message={
            <>
              Drop <b>{confirmDrop}</b>? This cannot be undone.
            </>
          }
          confirmLabel="Drop"
          onConfirm={() => {
            void dropStash(confirmDrop)
            setConfirmDrop(null)
          }}
          onClose={() => setConfirmDrop(null)}
        />
      )}
    </div>
  )
}
