import { useCallback, useEffect, useMemo, useState } from 'react'
import type { GitBranch, GitBranches, GitCommandResult } from '@shared/types'
import type { GitScope } from './GitPanel'
import { IconPlus, IconTrash } from '../common/Icons'
import { IconBranch, IconPull, IconPush } from './GitIcons'
import ConfirmDialog from '../common/ConfirmDialog'

/**
 * The Branches tab — local + remote refs with the current branch flagged,
 * ahead/behind counters, and actions (switch / new / delete / set upstream).
 *
 * Clicking a row selects it (so the per-branch action buttons show). Single
 * click on the name = checkout; the dedicated checkout button is the explicit
 * path for safety.
 */

export default function GitBranchesPanel({
  scope,
  onNewBranch,
  run,
  onError: _onError
}: {
  scope: GitScope
  onNewBranch: () => void
  run: (
    op: () => Promise<GitCommandResult>,
    onError?: (r: GitCommandResult) => void
  ) => Promise<GitCommandResult | null>
  onError: (msg: string | null) => void
}) {
  const [data, setData] = useState<GitBranches | null>(null)
  const [tick, setTick] = useState(0)
  const [busy, setBusy] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  // Branch names awaiting a delete confirmation.
  const [confirmDelete, setConfirmDelete] = useState<string[] | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.devterm.git.branches({ sessionId: scope.sessionId, path: scope.path }).then((b) => {
      if (!cancelled) setData(b)
    })
    return () => {
      cancelled = true
    }
  }, [scope.sessionId, scope.path, tick])

  const refresh = useCallback(() => setTick((t) => t + 1), [])

  const locals = useMemo(
    () => (data?.branches ?? []).filter((b) => !b.remote).sort(byCurrentThenName),
    [data]
  )
  const remotes = useMemo(
    () =>
      (data?.branches ?? []).filter((b) => b.remote).sort((a, b) => a.name.localeCompare(b.name)),
    [data]
  )

  const checkout = useCallback(
    async (target: string) => {
      setBusy(true)
      await run(() => window.devterm.git.checkout({ ...scope, target }))
      setBusy(false)
      refresh()
    },
    [run, scope, refresh]
  )

  const deleteBranches = useCallback(
    async (names: string[]) => {
      setBusy(true)
      await run(() => window.devterm.git.deleteBranch({ ...scope, names }))
      setBusy(false)
      refresh()
    },
    [run, scope, refresh]
  )

  const mergeIntoCurrent = useCallback(
    async (target: string) => {
      setBusy(true)
      await run(() => window.devterm.git.merge({ ...scope, target }))
      setBusy(false)
      refresh()
    },
    [run, scope, refresh]
  )

  const fetch = useCallback(
    async (remote: string) => {
      setBusy(true)
      await run(() => window.devterm.git.fetch({ ...scope, remote, prune: true }))
      setBusy(false)
      refresh()
    },
    [run, scope, refresh]
  )

  const push = useCallback(
    async (branch: string) => {
      setBusy(true)
      await run(() => window.devterm.git.push({ ...scope, branch, setUpstream: true }))
      setBusy(false)
      refresh()
    },
    [run, scope, refresh]
  )

  const pull = useCallback(
    async (branch: string) => {
      setBusy(true)
      await run(() => window.devterm.git.pull({ ...scope, branch }))
      setBusy(false)
      refresh()
    },
    [run, scope, refresh]
  )

  if (!data) return <div className="git-loading">loading…</div>

  return (
    <div className="git-branches">
      <div className="git-section">
        <div className="git-section-head">
          <span className="git-section-title">Local</span>
          <span className="git-section-count">{locals.length}</span>
          <span className="spacer" />
          <button className="git-mini" onClick={onNewBranch} title="New branch">
            <IconPlus size={12} />
            <span>New</span>
          </button>
        </div>
        <div className="git-section-body">
          {locals.length === 0 && <div className="git-row-empty">no local branches</div>}
          {locals.map((b) => (
            <BranchRow
              key={b.name}
              branch={b}
              busy={busy}
              selected={selected === b.name}
              onSelect={() => setSelected(b.name)}
              onCheckout={() => checkout(b.name)}
              onDelete={() => setConfirmDelete([b.name])}
              onPush={() => push(b.name)}
              onPull={() => pull(b.name)}
            />
          ))}
        </div>
      </div>

      <div className="git-section">
        <div className="git-section-head">
          <span className="git-section-title">Remotes</span>
          <span className="git-section-count">{remotes.length}</span>
        </div>
        <div className="git-section-body">
          {remotes.length === 0 && <div className="git-row-empty">no remote branches</div>}
          {remotes.map((b) => (
            <RemoteRow
              key={b.name}
              branch={b}
              busy={busy}
              onCheckout={() => checkout(b.name)}
              onMerge={() => mergeIntoCurrent(b.name)}
              onFetchRemote={() => fetch(b.name.split('/')[0])}
              onDelete={() => setConfirmDelete([b.name])}
            />
          ))}
        </div>
      </div>

      {confirmDelete && (
        <ConfirmDialog
          open
          title={confirmDelete.length === 1 ? 'Delete branch?' : 'Delete branches?'}
          message={
            <>
              Delete{' '}
              {confirmDelete.length === 1 ? (
                <>
                  branch <b>{confirmDelete[0]}</b>
                </>
              ) : (
                <b>{confirmDelete.length} branches</b>
              )}
              ? This cannot be undone.
            </>
          }
          onConfirm={() => {
            void deleteBranches(confirmDelete)
            setConfirmDelete(null)
          }}
          onClose={() => setConfirmDelete(null)}
        />
      )}
    </div>
  )
}

function byCurrentThenName(a: GitBranch, b: GitBranch): number {
  if (a.current !== b.current) return a.current ? -1 : 1
  return a.name.localeCompare(b.name)
}

function BranchRow({
  branch,
  busy,
  selected,
  onSelect,
  onCheckout,
  onDelete,
  onPush,
  onPull
}: {
  branch: GitBranch
  busy: boolean
  selected: boolean
  onSelect: () => void
  onCheckout: () => void
  onDelete: () => void
  onPush: () => void
  onPull: () => void
}) {
  return (
    <div
      className={`git-branch-row ${selected ? 'sel' : ''} ${branch.current ? 'current' : ''}`}
      onClick={onSelect}
    >
      <span className="git-branch-icon">
        <IconBranch size={13} />
      </span>
      <button
        className="git-row-name"
        onClick={(e) => {
          e.stopPropagation()
          onCheckout()
        }}
        disabled={busy || branch.current}
        title={branch.current ? `Currently on ${branch.name}` : `Checkout ${branch.name}`}
      >
        {branch.name}
        {branch.current && <span className="git-pill">current</span>}
      </button>
      {branch.upstream && (
        <span className="git-meta" title={`Tracking ${branch.upstream}`}>
          {branch.upstream.replace(/^[^/]+\//, '↗ ')}
        </span>
      )}
      {branch.ahead > 0 && <span className="git-ahead">↑{branch.ahead}</span>}
      {branch.behind > 0 && <span className="git-behind">↓{branch.behind}</span>}
      <span className="spacer" />
      {!branch.current && branch.behind > 0 && (
        <button
          className="git-icon-btn small"
          disabled={busy}
          onClick={(e) => {
            e.stopPropagation()
            onPull()
          }}
          title="Pull"
          aria-label="Pull"
        >
          <IconPull size={12} />
        </button>
      )}
      {!branch.current && branch.ahead > 0 && (
        <button
          className="git-icon-btn small"
          disabled={busy}
          onClick={(e) => {
            e.stopPropagation()
            onPush()
          }}
          title="Push"
          aria-label="Push"
        >
          <IconPush size={12} />
        </button>
      )}
      {!branch.current && (
        <button
          className="git-icon-btn small danger"
          disabled={busy}
          onClick={(e) => {
            e.stopPropagation()
            onDelete()
          }}
          title="Delete branch"
          aria-label="Delete"
        >
          <IconTrash size={12} />
        </button>
      )}
    </div>
  )
}

function RemoteRow({
  branch,
  busy,
  onCheckout,
  onMerge,
  onFetchRemote,
  onDelete
}: {
  branch: GitBranch
  busy: boolean
  onCheckout: () => void
  onMerge: () => void
  onFetchRemote: () => void
  onDelete: () => void
}) {
  const remote = branch.name.split('/')[0] || 'origin'
  return (
    <div className="git-branch-row remote">
      <span className="git-branch-icon">
        <IconBranch size={13} />
      </span>
      <button
        className="git-row-name"
        onClick={onCheckout}
        disabled={busy}
        title={`Checkout ${branch.name}`}
      >
        {branch.name}
      </button>
      <span className="spacer" />
      <button
        className="git-icon-btn small"
        onClick={onFetchRemote}
        disabled={busy}
        title={`Fetch ${remote}`}
        aria-label="Fetch"
      >
        <IconPull size={12} />
      </button>
      <button
        className="git-icon-btn small"
        onClick={onMerge}
        disabled={busy}
        title={`Merge ${branch.name} into current branch`}
        aria-label="Merge"
      >
        <IconMergeIcon size={12} />
      </button>
      <button
        className="git-icon-btn small danger"
        onClick={() => onDelete()}
        disabled={busy}
        title="Delete remote-tracking branch (local)"
        aria-label="Delete"
      >
        <IconTrash size={12} />
      </button>
    </div>
  )
}

function IconMergeIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8 4v5.5L4.5 13M16 4v5.5L19.5 13" />
      <path d="M5 13h14M12 13v7" />
    </svg>
  )
}
