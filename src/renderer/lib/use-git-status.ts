import { useEffect, useState } from 'react'
import { useSessions } from '../store/sessions'
import type { GitStatus } from '@shared/types'

/**
 * Live git status for the active session's cwd (local or remote). Follows the
 * same subscribe + watch pattern the status bar always used; extracted so the
 * titlebar git badge can share it without duplicating the subscription logic.
 * Returns `null` when there is no active session, no cwd, or the path is not
 * followed (browser panes). Callers check `status?.isRepo` themselves.
 */
export function useActiveGitStatus(enabled = true): GitStatus | null {
  const active = useSessions((s) => s.sessions.find((x) => x.id === s.activeId))
  const [git, setGit] = useState<GitStatus | null>(null)

  const activeId = active?.id
  const activeKind = active?.kind
  const activeCwd = active?.cwd

  useEffect(() => {
    if (!enabled) return
    if ((activeKind !== 'local' && activeKind !== 'remote') || !activeCwd) {
      setGit(null)
      return
    }
    let cancelled = false
    setGit(null)
    const args =
      activeKind === 'remote' && activeId
        ? { sessionId: activeId, path: activeCwd }
        : { path: activeCwd }
    void window.devterm.git
      .status(args)
      .then((s) => {
        if (!cancelled) setGit(s)
      })
      .catch(() => {
        if (!cancelled) setGit(null)
      })
    const off = window.devterm.git.onChange(args, (s) => {
      if (!cancelled) setGit(s)
    })
    window.devterm.git.watch(args)
    return () => {
      cancelled = true
      off()
    }
  }, [enabled, activeKind, activeCwd, activeId])

  return git
}

/** Number of changed paths — the badge count for git buttons. */
export function gitChangeCount(status: GitStatus | null): number {
  if (!status?.isRepo) return 0
  return Object.keys(status.entries ?? {}).length
}
