import { useEffect, useRef, useState } from 'react'
import { useSessions } from '../../store/sessions'
import { useSettings } from '../../store/settings'
import { IconLocal, IconRemote, IconBrowser } from '../common/Icons'
import { IconBranch } from '../git/GitIcons'
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

function agentLabel(state?: string): string | null {
  if (!state) return null
  switch (state) {
    case 'connecting':
      return 'Connecting'
    case 'starting':
      return 'Starting bridge'
    case 'listening':
      return 'Waiting for agent'
    case 'connected':
      return 'Agent connected'
    case 'disconnected':
      return 'Bridge disconnected'
    case 'stopped':
      return 'Agent stopped'
    case 'exited':
      return 'Agent exited'
    case 'error':
      return 'Agent error'
    default:
      return state
  }
}

function statusTone(status?: string): string {
  if (!status) return ''
  if (status.startsWith('reconnect failed') || status.toLowerCase().includes('error')) return 'err'
  if (status.startsWith('reconnecting') || status.includes('cancelled')) return 'warn'
  return ''
}

const SSH_PING_INITIAL_MS = 30_000
const SSH_PING_MAX_MS = 5 * 60_000

export default function StatusBar() {
  const active = useSessions((s) => s.sessions.find((x) => x.id === s.activeId))
  const showStatusBar = useSettings((s) => s.showStatusBar)
  const zenMode = useSettings((s) => s.zenMode)
  const [git, setGit] = useState<GitStatus | null>(null)
  const [latency, setLatency] = useState<{ ms: number | null; err?: string } | null>(null)

  const activeId = active?.id
  const activeKind = active?.kind
  const activeCwd = active?.cwd
  const activeClosed = active?.closed

  useEffect(() => {
    if (!showStatusBar) return
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
    void window.devterm.git.status(args).then((s) => {
      if (!cancelled) setGit(s)
    })
    const off = window.devterm.git.onChange(args, (s) => {
      if (!cancelled) setGit(s)
    })
    window.devterm.git.watch(args)
    return () => {
      cancelled = true
      off()
    }
  }, [showStatusBar, activeKind, activeCwd, activeId])

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
        <span className="status-cell">Ready</span>
        <span className="spacer" />
      </div>
    )
  }

  const agentText = agentLabel(active.agentBridgeState)
  const msgTone = statusTone(active.status)

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
            {active.status && <span className={`status-msg ${msgTone}`}>{active.status}</span>}
          </>
        )}
        {git?.isRepo && (
          <span className="status-cell status-git" title={`Branch: ${git.branch}`}>
            <IconBranch size={12} />
            {git.branch || 'detached'}
            {git.ahead > 0 ? ` ↑${git.ahead}` : ''}
            {git.behind > 0 ? ` ↓${git.behind}` : ''}
          </span>
        )}
        {active.kind === 'remote' && latency !== null && (
          <span
            className={`status-cell status-ssh ${latency.err ? 'err' : ''}`}
            title={latency.err ?? `Round-trip: ${latency.ms} ms`}
          >
            {latency.err ? 'SSH error' : `SSH ${latency.ms ?? '—'} ms`}
          </span>
        )}
      </span>

      <span className="spacer" />

      <span className="statusbar-right">
        {agentText && (
          <span
            className="status-cell status-agent"
            title={`Agent bridge: ${active.agentBridgeState}`}
          >
            {agentText}
          </span>
        )}
      </span>
    </div>
  )
}
