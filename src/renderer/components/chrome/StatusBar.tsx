import { useEffect, useRef, useState } from 'react'
import { useSessions } from '../../store/sessions'
import { useSettings } from '../../store/settings'
import { IconLocal, IconRemote, IconBrowser } from '../common/Icons'
import type { GitStatus, HostContext } from '@shared/types'

function osLabel(os?: string): string {
  switch (os) {
    case 'windows':
      return 'Windows'
    case 'linux':
      return 'Linux'
    case 'mac':
      return 'macOS'
    default:
      return 'unknown'
  }
}

function ContextBadge({ ctx }: { ctx?: HostContext }) {
  if (!ctx) return <span className="ctx ctx-pending">connecting…</span>
  return (
    <span className={`ctx ctx-${ctx.kind}`} title={ctx.detail}>
      {ctx.kind === 'local' ? <IconLocal size={12} /> : <IconRemote size={12} />}
      {ctx.kind === 'local' ? 'Local' : 'Remote'} · {osLabel(ctx.os)}
    </span>
  )
}

/** Pinging the SSH server is expensive; back off exponentially on failure. */
const SSH_PING_INITIAL_MS = 30_000
const SSH_PING_MAX_MS = 5 * 60_000

export default function StatusBar() {
  const active = useSessions((s) => s.sessions.find((x) => x.id === s.activeId))
  const showStatusBar = useSettings((s) => s.showStatusBar)
  const zenMode = useSettings((s) => s.zenMode)
  const [git, setGit] = useState<GitStatus | null>(null)
  const [latency, setLatency] = useState<{ ms: number | null; err?: string } | null>(null)

  // Depend on primitives only — the whole `active` object is replaced on every
  // store update (cwd tick, status, agent bridge), which would re-subscribe
  // git watchers and restart the latency loop with an immediate SSH exec.
  const activeId = active?.id
  const activeKind = active?.kind
  const activeCwd = active?.cwd
  const activeClosed = active?.closed

  // Local sessions: lazy-fetch git status for the cwd.
  useEffect(() => {
    if (!showStatusBar) return
    if (activeKind !== 'local' || !activeCwd) {
      setGit(null)
      return
    }
    let cancelled = false
    setGit(null)
    void window.devterm.git.status({ path: activeCwd }).then((s) => {
      if (!cancelled) setGit(s)
    })
    const off = window.devterm.git.onChange({ path: activeCwd }, (s) => {
      if (!cancelled) setGit(s)
    })
    window.devterm.git.watch({ path: activeCwd })
    return () => {
      cancelled = true
      off()
    }
  }, [showStatusBar, activeKind, activeCwd])

  // Remote sessions: probe latency with exponential backoff on failure.
  const backoffRef = useRef(SSH_PING_INITIAL_MS)
  useEffect(() => {
    if (!showStatusBar) return
    if (activeKind !== 'remote' || !activeId || activeClosed) {
      setLatency(null)
      return
    }
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const tick = async () => {
      if (cancelled) return
      const t0 = Date.now()
      try {
        if (activeCwd) {
          await window.devterm.git.status({ sessionId: activeId, path: activeCwd })
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
  }, [showStatusBar, activeKind, activeId, activeCwd, activeClosed])

  if (!showStatusBar || zenMode) return null
  if (!active) {
    return (
      <div className="statusbar" role="status" aria-label="Session status">
        <span className="status-cell">ready</span>
        <span className="spacer" />
      </div>
    )
  }

  const agentState = active.agentBridgeState

  return (
    <div className="statusbar" role="status" aria-label="Session status">
      <span className="statusbar-cluster-c">
        {active.kind === 'browser' ? (
          <>
            <span className="ctx ctx-browser">
              <IconBrowser size={12} />
              Browser
            </span>
            <span className="status-msg">
              {active.title && active.title !== 'Browser' ? active.title : 'open'}
            </span>
          </>
        ) : (
          <>
            <ContextBadge ctx={active.context} />
            {active.status && <span className="status-msg">{active.status}</span>}
          </>
        )}
        {active.kind === 'local' && git?.isRepo && (
          <span className="status-cell status-git" title={`Branch: ${git.branch}`}>
            ⎇ {git.branch || 'detached'}
            {git.ahead > 0 ? ` ↑${git.ahead}` : ''}
            {git.behind > 0 ? ` ↓${git.behind}` : ''}
          </span>
        )}
        {active.kind === 'remote' && latency !== null && (
          <span
            className={`status-cell status-ssh ${latency.err ? 'err' : ''}`}
            title={latency.err ?? `Round-trip: ${latency.ms} ms`}
          >
            {latency.err ? '⚠ SSH' : `SSH ${latency.ms ?? '—'} ms`}
          </span>
        )}
      </span>

      <span className="spacer" />

      <span className="statusbar-right">
        {agentState && (
          <span className="status-cell status-agent" title={`Agent bridge: ${agentState}`}>
            {agentState}
          </span>
        )}
      </span>
    </div>
  )
}
