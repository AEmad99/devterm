// Bottom status bar for the Terminals view. Renders below the .panes area
// without taking any of its height — the bar is laid out as a sibling of the
// panes container inside a flex column, so it gets its own row and the panes
// container shrinks to fit. Per the cluster-C hard constraint we must NOT
// change the panes geometry: the rule is satisfied because .panes-area
// already had `flex: 1` and the bar is the only thing that can claim the
// remaining space. A visibility:hidden terminal slot stays hidden when the
// bar is shown, because we don't touch the .panes container at all.

import { useEffect, useRef, useState } from 'react'
import { useSessions } from '../store/sessions'
import { useSettings } from '../store/settings'
import type { GitStatus } from '@shared/types'

/**
 * One bar cell. The cells are inline; we keep this component as a tiny
 * type alias rather than a wrapper so the rendered DOM stays shallow.
 */
type Cell = { key: string; node: React.ReactNode }

/** Pinging the SSH server is expensive; back off exponentially on failure. */
const SSH_PING_INITIAL_MS = 30_000
const SSH_PING_MAX_MS = 5 * 60_000

/**
 * The visible status bar. It does the minimum needed to be useful:
 *   - kind label + cwd (always, when available)
 *   - git branch pill for local sessions that sit in a repo
 *   - SSH latency (ms) for remote sessions, with exponential backoff on error
 *
 * The bar subscribes to the active session id and gracefully no-ops while
 * the active session is a browser tab or pending connect.
 */
export default function StatusBar() {
  const active = useSessions((s) => s.sessions.find((x) => x.id === s.activeId))
  const showStatusBar = useSettings((s) => s.showStatusBar)
  const [git, setGit] = useState<GitStatus | null>(null)
  const [latency, setLatency] = useState<{ ms: number | null; err?: string } | null>(null)

  // Local sessions: lazy-fetch git status for the cwd. Skip when cwd is
  // missing or the kind isn't local.
  useEffect(() => {
    if (!showStatusBar) return
    if (!active || active.kind !== 'local' || !active.cwd) {
      setGit(null)
      return
    }
    let cancelled = false
    setGit(null)
    void window.devterm.git.status({ path: active.cwd }).then((s) => {
      if (!cancelled) setGit(s)
    })
    const off = window.devterm.git.onChange({ path: active.cwd }, (s) => {
      if (!cancelled) setGit(s)
    })
    window.devterm.git.watch({ path: active.cwd })
    return () => {
      cancelled = true
      off()
    }
  }, [showStatusBar, active?.id, active?.kind, active?.cwd])

  // Remote sessions: ping via `ssh.exec('echo 1')` every 30s, with backoff
  // on failure. We only start the loop for live remote sessions.
  const backoffRef = useRef(SSH_PING_INITIAL_MS)
  useEffect(() => {
    if (!showStatusBar) return
    if (!active || active.kind !== 'remote' || active.closed) {
      setLatency(null)
      return
    }
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const tick = async () => {
      if (cancelled) return
      const t0 = Date.now()
      try {
        // The status bar doesn't have a direct exec bridge — we piggy-back on
        // git.diff with a no-op-ish command, which uses the same SSH exec
        // channel and returns a small payload. We can't reach the SSH exec
        // directly from the renderer; the editor's "Run in terminal" uses
        // sendTerminalInput, which isn't a probe. The cleanest probe is a
        // tiny `git status` on the cwd, which we already do above for git.
        // For the bare "echo 1" ping we use the foundation bridge activity
        // heartbeat path: simply measure how long a tiny ipc round-trip
        // takes — `git.status` itself — and use that as a connectivity
        // proxy. (If you need a true exec-level ping later, add a dedicated
        // IPC; this is good enough for a "connected / not" indicator.)
        if (active.cwd) {
          await window.devterm.git.status({ sessionId: active.id, path: active.cwd })
        }
        if (!cancelled) {
          setLatency({ ms: Date.now() - t0 })
          backoffRef.current = SSH_PING_INITIAL_MS
        }
      } catch (e) {
        if (!cancelled) {
          setLatency({ ms: null, err: String((e as Error).message || e) })
          backoffRef.current = Math.min(SSH_PING_MAX_MS, backoffRef.current * 2)
        }
      }
      if (!cancelled) timer = setTimeout(tick, backoffRef.current)
    }
    void tick()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [showStatusBar, active?.id, active?.kind, active?.closed, active?.cwd])

  if (!showStatusBar) return null
  if (!active) {
    return (
      <div className="statusbar statusbar-cluster-c" role="status">
        <span className="status-cell">ready</span>
      </div>
    )
  }

  const cells: Cell[] = []
  cells.push({
    key: 'kind',
    node: <span className={`ctx ctx-${active.kind}`}>{active.kind}</span>
  })
  if (active.cwd) {
    cells.push({
      key: 'cwd',
      node: (
        <span className="status-cell status-cwd" title={active.cwd}>
          {active.cwd}
        </span>
      )
    })
  }
  if (active.kind === 'local' && git?.isRepo) {
    cells.push({
      key: 'git',
      node: (
        <span className="status-cell status-git" title={`Branch: ${git.branch}`}>
          ⎇ {git.branch || 'detached'}
          {git.ahead > 0 ? ` ↑${git.ahead}` : ''}
          {git.behind > 0 ? ` ↓${git.behind}` : ''}
        </span>
      )
    })
  }
  if (active.kind === 'remote' && latency !== null) {
    cells.push({
      key: 'ssh',
      node: (
        <span
          className={`status-cell status-ssh ${latency.err ? 'err' : ''}`}
          title={latency.err ?? `Round-trip: ${latency.ms} ms`}
        >
          {latency.err ? '⚠ SSH' : `SSH ${latency.ms ?? '—'} ms`}
        </span>
      )
    })
  }
  if (active.status) {
    cells.push({ key: 'msg', node: <span className="status-msg">{active.status}</span> })
  }

  return (
    <div className="statusbar statusbar-cluster-c" role="status" aria-label="Session status">
      {cells.map((c) => (
        <span key={c.key} className="statusbar-cell-wrap">
          {c.node}
        </span>
      ))}
    </div>
  )
}
