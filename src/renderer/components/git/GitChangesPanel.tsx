import { useCallback, useMemo, useState } from 'react'
import type { GitCommandResult, GitFileStatus, GitStatus } from '@shared/types'
import type { GitScope } from './GitPanel'
import { IconStage, IconUnstage, IconRevert, IconCommit } from './GitIcons'
import ConfirmDialog from '../common/ConfirmDialog'
import { useEscapeKey } from '../../lib/useEscapeKey'

/**
 * The Changes tab — staged + unstaged + untracked files with stage/unstage/
 * discard actions and a quick "Open commit" button. The split mirrors git's
 * own two-section layout; the diff viewer is opened by clicking a row.
 */

interface Row {
  /** Repo-relative path. */
  path: string
  /** Working-tree status (M/A/D/?/U/R). */
  status: GitFileStatus
  /** True when the row is staged. Drives the badge colour + action. */
  staged: boolean
}

export default function GitChangesPanel({
  scope,
  status,
  onCommit,
  onError,
  run
}: {
  scope: GitScope
  status: GitStatus
  onCommit: () => void
  onError: (msg: string | null) => void
  run: (
    op: () => Promise<GitCommandResult>,
    onError?: (r: GitCommandResult) => void
  ) => Promise<GitCommandResult | null>
}) {
  const [diff, setDiff] = useState<null | { path: string; staged: boolean; text: string }>(null)
  const [loadingDiff, setLoadingDiff] = useState<string | null>(null)
  // File awaiting a "discard working-tree changes" confirmation.
  const [discardPath, setDiscardPath] = useState<string | null>(null)

  // The diff viewer manages its own markup (not ModalShell) — close on Esc.
  useEscapeKey(
    useCallback(() => setDiff(null), []),
    diff !== null
  )

  // Split the status map into staged vs working-tree rows.
  const rows = useMemo(() => splitRows(status), [status])

  const hasStaged = rows.staged.length > 0
  const hasUnstaged = rows.unstaged.length > 0
  const hasUntracked = rows.untracked.length > 0

  const openDiff = useCallback(
    async (path: string, staged: boolean) => {
      setLoadingDiff(path)
      try {
        const text = await window.devterm.git.diff({
          sessionId: scope.sessionId,
          path: scope.path,
          file: path
        })
        setDiff({ path, staged, text: text || '(no diff)' })
      } catch (e) {
        onError(String((e as Error).message || e))
      } finally {
        setLoadingDiff(null)
      }
    },
    [scope.path, scope.sessionId, onError]
  )

  const stageAll = useCallback(
    () =>
      run(() => window.devterm.git.stage({ ...scope, files: rows.unstaged.map((r) => r.path) })),
    [run, scope, rows.unstaged]
  )
  const unstageAll = useCallback(
    () =>
      run(() => window.devterm.git.unstage({ ...scope, files: rows.staged.map((r) => r.path) })),
    [run, scope, rows.staged]
  )

  if (!hasStaged && !hasUnstaged && !hasUntracked) {
    return <div className="git-empty">Working tree clean</div>
  }

  return (
    <div className="git-changes">
      {hasUnstaged && (
        <Section
          title="Changes"
          count={rows.unstaged.length}
          action={
            <button className="git-mini" onClick={stageAll} title="Stage all changes">
              <IconStage size={12} />
              <span>Stage all</span>
            </button>
          }
        >
          {rows.unstaged.map((r) => (
            <FileRow
              key={`w:${r.path}`}
              row={r}
              actionLabel="Stage"
              actionIcon={<IconStage size={12} />}
              loading={loadingDiff === r.path}
              onAction={() => run(() => window.devterm.git.stage({ ...scope, files: [r.path] }))}
              onDiscard={() => setDiscardPath(r.path)}
              onShowDiff={() => openDiff(r.path, false)}
            />
          ))}
        </Section>
      )}

      {hasStaged && (
        <Section
          title="Staged"
          count={rows.staged.length}
          action={
            <button className="git-mini" onClick={unstageAll} title="Unstage all">
              <IconUnstage size={12} />
              <span>Unstage all</span>
            </button>
          }
        >
          {rows.staged.map((r) => (
            <FileRow
              key={`s:${r.path}`}
              row={r}
              actionLabel="Unstage"
              actionIcon={<IconUnstage size={12} />}
              loading={loadingDiff === r.path}
              onAction={() => run(() => window.devterm.git.unstage({ ...scope, files: [r.path] }))}
              onShowDiff={() => openDiff(r.path, true)}
            />
          ))}
        </Section>
      )}

      {hasUntracked && (
        <Section title="Untracked" count={rows.untracked.length}>
          {rows.untracked.map((r) => (
            <FileRow
              key={`u:${r.path}`}
              row={r}
              actionLabel="Track"
              actionIcon={<IconStage size={12} />}
              loading={loadingDiff === r.path}
              onAction={() => run(() => window.devterm.git.stage({ ...scope, files: [r.path] }))}
              onShowDiff={() => undefined}
            />
          ))}
        </Section>
      )}

      <div className="git-changes-actions">
        <button className="git-primary" disabled={!hasStaged} onClick={onCommit}>
          <IconCommit size={13} />
          <span>Commit {hasStaged ? `${rows.staged.length}` : ''}</span>
        </button>
      </div>

      {diff && (
        <div className="modal-backdrop" onClick={() => setDiff(null)}>
          <div className="modal git-diff-modal" onClick={(e) => e.stopPropagation()}>
            <h3>
              {diff.staged ? 'Staged ' : ''}Changes — {diff.path}
            </h3>
            <pre className="git-diff-pre">{diff.text}</pre>
            <div className="actions">
              <button onClick={() => setDiff(null)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {discardPath && (
        <ConfirmDialog
          open
          title="Discard changes?"
          message={
            <>
              Discard working-tree changes to <b>{discardPath}</b>? This cannot be undone.
            </>
          }
          confirmLabel="Discard"
          onConfirm={() => {
            void run(() => window.devterm.git.discard({ ...scope, files: [discardPath] }))
            setDiscardPath(null)
          }}
          onClose={() => setDiscardPath(null)}
        />
      )}
    </div>
  )
}

function splitRows(status: GitStatus): {
  staged: Row[]
  unstaged: Row[]
  untracked: Row[]
} {
  const staged: Row[] = []
  const unstaged: Row[] = []
  const untracked: Row[] = []
  for (const [path, code] of Object.entries(status.entries)) {
    if (code === '?') {
      untracked.push({ path, status: code, staged: false })
      continue
    }
    if (code === 'A' || code === 'R') {
      // 'A' in git's porcelain means staged add; treat as staged.
      staged.push({ path, status: code, staged: true })
      continue
    }
    if (code === 'U') {
      staged.push({ path, status: code, staged: true })
      continue
    }
    // Single-letter M/D: ambiguous in the simplified model; show as unstaged.
    unstaged.push({ path, status: code, staged: false })
  }
  return { staged, unstaged, untracked }
}

function Section({
  title,
  count,
  action,
  children
}: {
  title: string
  count: number
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="git-section">
      <div className="git-section-head">
        <span className="git-section-title">{title}</span>
        <span className="git-section-count">{count}</span>
        <span className="spacer" />
        {action}
      </div>
      <div className="git-section-body">{children}</div>
    </div>
  )
}

function FileRow({
  row,
  actionLabel,
  actionIcon,
  onAction,
  onDiscard,
  onShowDiff,
  loading
}: {
  row: Row
  actionLabel: string
  actionIcon: React.ReactNode
  onAction: () => void
  onDiscard?: () => void
  onShowDiff: () => void
  loading: boolean
}) {
  return (
    <div className={`git-row git-row-${row.status.toLowerCase()}`} title={row.path}>
      <span className={`git-badge git-${row.status.toLowerCase()}`}>{row.status}</span>
      <button
        className="git-row-name"
        onClick={onShowDiff}
        disabled={loading || row.status === '?'}
        title="Show changes"
      >
        {row.path}
      </button>
      {onDiscard && (
        <button
          className="git-icon-btn small"
          onClick={onDiscard}
          title="Discard working-tree changes"
          aria-label="Discard"
        >
          <IconRevert size={12} />
        </button>
      )}
      <button
        className="git-icon-btn small"
        onClick={onAction}
        title={actionLabel}
        aria-label={actionLabel}
      >
        {actionIcon}
      </button>
    </div>
  )
}

// Re-export the row-shape for sibling files (test-only).
export type { Row as ChangeRow }
