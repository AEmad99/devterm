import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSessions } from '../../store/sessions'
import type { GitCommandResult, GitStatus } from '@shared/types'
import GitBranchesPanel from './GitBranchesPanel'
import GitChangesPanel from './GitChangesPanel'
import GitLogPanel from './GitLogPanel'
import GitStashPanel from './GitStashPanel'
import GitTagsPanel from './GitTagsPanel'
import GitRemotesPanel from './GitRemotesPanel'
import CommitModal from './CommitModal'
import NewBranchModal from './NewBranchModal'
import NewRemoteModal from './NewRemoteModal'
import NewTagModal from './NewTagModal'
import { IconBranch, IconCommit, IconHistory, IconPull, IconStash, IconTag } from './GitIcons'
import { IconRefresh } from '../common/Icons'

/** A scope is the resolved target for git commands — either a local cwd or
 *  the cwd of an open remote SSH session. The panel never asks the user for
 *  a path; it follows the active session, falling back to the last known cwd. */
export interface GitScope {
  sessionId: string | undefined
  path: string
}

type Tab = 'changes' | 'branches' | 'log' | 'stash' | 'tags' | 'remotes'

/**
 * Sidebar git panel — the Warp-style one-stop view. Follows the active
 * session's cwd (local or remote) and exposes:
 *  - Changes (staged + unstaged, file list, stage/unstage, diff, commit)
 *  - Branches (local + remote, current marker, ahead/behind, switch/new)
 *  - Log (commit history with author + sha + refs)
 *  - Stash (list, apply, drop, pop)
 *  - Tags (list, create, delete)
 *  - Remotes (list, add, remove, fetch/pull/push)
 *
 * All operations route through `window.devterm.git` which itself routes
 * through the main-process IPC layer. Local + remote work the same way; the
 * IPC handler decides which side to invoke.
 */
export default function GitPanel({ className = '' }: { className?: string }) {
  const active = useSessions((s) => s.sessions.find((x) => x.id === s.activeId))
  const cwd = active?.cwd
  const isPending = !active || active.id.startsWith('pending-')
  const isBrowser = active?.kind === 'browser'

  const scope: GitScope | null = useMemo(() => {
    if (isPending || isBrowser) return null
    if (!cwd) return null
    return { sessionId: active?.kind === 'remote' ? active?.id : undefined, path: cwd }
  }, [active?.id, active?.kind, cwd, isBrowser, isPending])

  const [tab, setTab] = useState<Tab>('changes')
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshTick, setRefreshTick] = useState(0)

  // Live status subscription. When the cwd changes we re-subscribe; the
  // status state holds the latest snapshot.
  useEffect(() => {
    if (!scope) return
    let cancelled = false
    setStatus(null)
    setError(null)
    const target = { sessionId: scope.sessionId, path: scope.path }
    void window.devterm.git.status(target).then((s) => {
      if (!cancelled) setStatus(s)
    })
    window.devterm.git.watch(target)
    const off = window.devterm.git.onChange(target, (s) => {
      if (!cancelled) setStatus(s)
    })
    return () => {
      cancelled = true
      off()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope?.sessionId, scope?.path, refreshTick])

  const refresh = useCallback(() => setRefreshTick((t) => t + 1), [])

  // Run a write-side mutation; on failure surface git's stderr so the user
  // sees what failed (auth, conflict, etc.). Always refreshes the snapshot
  // afterwards because most writes change status.
  const run = useCallback(
    async (
      op: () => Promise<GitCommandResult>,
      onError?: (r: GitCommandResult) => void
    ): Promise<GitCommandResult | null> => {
      try {
        const r = await op()
        if (!r.ok) {
          const msg = r.stderr.trim() || r.stdout.trim() || `${r.code ?? '?'}`
          setError(msg)
          onError?.(r)
        } else {
          setError(null)
        }
        refresh()
        return r
      } catch (e) {
        setError(String((e as Error).message || e))
        refresh()
        return null
      }
    },
    [refresh]
  )

  const [commitOpen, setCommitOpen] = useState(false)
  const [newBranchOpen, setNewBranchOpen] = useState(false)
  const [newTagOpen, setNewTagOpen] = useState(false)
  const [newRemoteOpen, setNewRemoteOpen] = useState(false)

  if (isPending || isBrowser || !scope) {
    return (
      <div className={`git-panel ${className}`}>
        <div className="git-panel-head">
          <span className="git-panel-title">Git</span>
        </div>
        <div className="git-panel-empty">
          {isBrowser
            ? 'Git is unavailable in browser tabs.'
            : active
              ? 'connecting…'
              : 'No active session'}
        </div>
      </div>
    )
  }

  return (
    <div className={`git-panel ${className}`}>
      <div className="git-panel-head">
        <span className="git-panel-title">Git</span>
        {status?.isRepo && (
          <span className="git-panel-branch" title={`On ${status.branch}`}>
            <IconBranch size={13} />
            {status.branch || 'detached'}
            {status.ahead > 0 && <span className="git-ahead">↑{status.ahead}</span>}
            {status.behind > 0 && <span className="git-behind">↓{status.behind}</span>}
          </span>
        )}
        <span className="spacer" />
        <button className="git-icon-btn" title="Refresh" onClick={refresh} aria-label="Refresh">
          <IconRefresh size={14} />
        </button>
      </div>

      {!status ? (
        <div className="git-panel-loading">loading…</div>
      ) : !status.isRepo ? (
        <div className="git-panel-empty">
          Not a git repository
          <span className="git-panel-path" title={scope.path}>
            {scope.path}
          </span>
        </div>
      ) : (
        <>
          <div className="git-panel-tabs" role="tablist">
            <TabButton id="changes" tab={tab} setTab={setTab} icon={<IconCommit size={13} />}>
              Changes
            </TabButton>
            <TabButton id="branches" tab={tab} setTab={setTab} icon={<IconBranch size={13} />}>
              Branches
            </TabButton>
            <TabButton id="log" tab={tab} setTab={setTab} icon={<IconHistory size={13} />}>
              Log
            </TabButton>
            <TabButton id="stash" tab={tab} setTab={setTab} icon={<IconStash size={13} />}>
              Stash
            </TabButton>
            <TabButton id="tags" tab={tab} setTab={setTab} icon={<IconTag size={13} />}>
              Tags
            </TabButton>
            <TabButton id="remotes" tab={tab} setTab={setTab} icon={<IconPull size={13} />}>
              Remotes
            </TabButton>
          </div>

          {error && (
            <div className="git-panel-error" role="alert">
              <pre>{error}</pre>
              <button onClick={() => setError(null)} aria-label="Dismiss">
                ×
              </button>
            </div>
          )}

          <div className="git-panel-body">
            {tab === 'changes' && (
              <GitChangesPanel
                scope={scope}
                status={status}
                onCommit={() => setCommitOpen(true)}
                onError={setError}
                run={run}
              />
            )}
            {tab === 'branches' && (
              <GitBranchesPanel
                scope={scope}
                onNewBranch={() => setNewBranchOpen(true)}
                run={run}
                onError={setError}
              />
            )}
            {tab === 'log' && <GitLogPanel scope={scope} />}
            {tab === 'stash' && <GitStashPanel scope={scope} run={run} onError={setError} />}
            {tab === 'tags' && (
              <GitTagsPanel
                scope={scope}
                onNewTag={() => setNewTagOpen(true)}
                run={run}
                onError={setError}
              />
            )}
            {tab === 'remotes' && (
              <GitRemotesPanel
                scope={scope}
                onNewRemote={() => setNewRemoteOpen(true)}
                run={run}
                onError={setError}
              />
            )}
          </div>
        </>
      )}

      {commitOpen && (
        <CommitModal scope={scope} onClose={() => setCommitOpen(false)} onDone={refresh} />
      )}
      {newBranchOpen && (
        <NewBranchModal scope={scope} onClose={() => setNewBranchOpen(false)} onDone={refresh} />
      )}
      {newTagOpen && (
        <NewTagModal scope={scope} onClose={() => setNewTagOpen(false)} onDone={refresh} />
      )}
      {newRemoteOpen && (
        <NewRemoteModal scope={scope} onClose={() => setNewRemoteOpen(false)} onDone={refresh} />
      )}
    </div>
  )
}

function TabButton({
  id,
  tab,
  setTab,
  icon,
  children
}: {
  id: Tab
  tab: Tab
  setTab: (t: Tab) => void
  icon: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <button
      role="tab"
      aria-selected={tab === id}
      className={`git-tab ${tab === id ? 'active' : ''}`}
      onClick={() => setTab(id)}
    >
      {icon}
      <span>{children}</span>
    </button>
  )
}
