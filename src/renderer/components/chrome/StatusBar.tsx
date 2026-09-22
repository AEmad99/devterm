import { useEffect, useRef, useState } from 'react'
import { useSessions } from '../../store/sessions'
import { useSettings } from '../../store/settings'
import { IconLocal, IconRemote, IconBrowser } from '../common/Icons'
import { IconBranch } from '../git/GitIcons'
import { agentKindLabel, setAgentUiMode } from '../../lib/agent-ui'
import { useActiveGitStatus } from '../../lib/use-git-status'
import { useTransfers } from '../../store/transfers'
import { useShallow } from 'zustand/react/shallow'
import type { HostContext } from '@shared/types'

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

/** Byte-weighted overall percent across in-flight transfers (0–100). */
function transferAggregate(items: { transferred: number; total: number }[]): number {
  let done = 0
  let total = 0
  for (const it of items) {
    done += Math.max(0, it.transferred)
    total += Math.max(0, it.total)
  }
  if (total <= 0) return 0
  return Math.min(100, Math.round((done / total) * 100))
}

function DockToggles() {
  const transfersOpen = useSettings((s) => s.transfersPanelOpen)
  const setTransfersOpen = useSettings((s) => s.setTransfersPanelOpen)
  const activityCollapsed = useSettings((s) => s.agentActivityCollapsed)
  const setActivityCollapsed = useSettings((s) => s.setAgentActivityCollapsed)
  const pendingApprovals = useSessions(
    (s) => s.sessions.filter((x) => x.agentPendingApproval).length
  )
  const runningTransfers = useTransfers(useShallow((s) => s.items.filter((it) => !it.done)))
  const running = runningTransfers.length
  const pct = transferAggregate(runningTransfers)

  return (
    <>
      <button
        type="button"
        className="status-cell status-link status-toggle"
        aria-pressed={!activityCollapsed}
        title={
          pendingApprovals
            ? `${pendingApprovals} approval(s) waiting — click to ${activityCollapsed ? 'show' : 'hide'} activity`
            : activityCollapsed
              ? 'Show agent activity'
              : 'Hide agent activity'
        }
        onClick={() => setActivityCollapsed(!activityCollapsed)}
      >
        Activity{pendingApprovals > 0 ? ` ${pendingApprovals}` : ''}
      </button>
      <button
        type="button"
        className="status-cell status-link status-toggle"
        aria-pressed={transfersOpen}
        title={
          running
            ? `${running} transfer(s) in flight — click to ${transfersOpen ? 'hide' : 'show'} the queue`
            : transfersOpen
              ? 'Hide the transfers panel'
              : 'Show the transfers panel'
        }
        onClick={() => setTransfersOpen(!transfersOpen)}
      >
        Transfers{running > 0 ? ` ${running} · ${pct}%` : ''}
      </button>
    </>
  )
}

const SSH_PING_INITIAL_MS = 30_000
const SSH_PING_MAX_MS = 5 * 60_000

export default function StatusBar() {
  const active = useSessions((s) => s.sessions.find((x) => x.id === s.activeId))
  const showStatusBar = useSettings((s) => s.showStatusBar)
  const zenMode = useSettings((s) => s.zenMode)
  const git = useActiveGitStatus(showStatusBar)
  const [latency, setLatency] = useState<{ ms: number | null; err?: string } | null>(null)
  // Bumped when the operator clicks the SSH pill to force an immediate sample.
  const [probeNonce, setProbeNonce] = useState(0)
  const settingsKind = useSettings((s) => s.agentKind)

  const activeId = active?.id
  const activeKind = active?.kind
  const activeCwd = active?.cwd
  const activeClosed = active?.closed

  const backoffRef = useRef(SSH_PING_INITIAL_MS)
  useEffect(() => {
    if (!showStatusBar) return
    if (activeKind !== 'remote' || !activeId || activeClosed) {
      setLatency(null)
      return
    }
    // A previous host's failure backoff must not leak into this session's
    // first sample.
    backoffRef.current = SSH_PING_INITIAL_MS
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
  }, [showStatusBar, activeKind, activeId, activeCwd, activeClosed, probeNonce])

  if (!showStatusBar || zenMode) return null
  if (!active) {
    return (
      <div className="statusbar" role="status" aria-label="Session status">
        <span className="status-cell">Ready</span>
        <span className="spacer" />
        <span className="statusbar-right">
          <DockToggles />
        </span>
      </div>
    )
  }

  const agentText = active.agentStartError
    ? 'Agent failed'
    : active.agentExited
      ? 'Agent exited'
      : agentLabel(active.agentBridgeState)
  const agentTone = active.agentPendingApproval
    ? 'warn'
    : active.agentStartError || active.agentExited
      ? 'err'
      : ''
  const msgTone = statusTone(active.status)
  const kind = active.agentKind ?? settingsKind
  const kindName = agentKindLabel(kind)
  const canStartAgent =
    !active.closed && (active.kind === 'local' || (active.kind === 'remote' && !!active.context))

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
          <button
            type="button"
            className="status-cell status-git"
            title={`Branch: ${git.branch} — click to open the Git panel`}
            onClick={() => {
              const s = useSettings.getState()
              s.setGitPanelOpen(!s.gitPanelOpen)
            }}
          >
            <IconBranch size={12} />
            {git.branch || 'detached'}
            {git.ahead > 0 ? ` ↑${git.ahead}` : ''}
            {git.behind > 0 ? ` ↓${git.behind}` : ''}
          </button>
        )}
        {active.kind === 'remote' && latency !== null && (
          <button
            type="button"
            className={`status-cell status-ssh status-link ${latency.err ? 'err' : ''}`}
            title={`${latency.err ?? `Round-trip latency: ${latency.ms} ms`} — click to probe now`}
            onClick={() => {
              backoffRef.current = SSH_PING_INITIAL_MS
              setLatency(null)
              setProbeNonce((n) => n + 1)
            }}
          >
            {latency.err ? 'SSH error' : `SSH ~${latency.ms ?? '—'} ms`}
          </button>
        )}
      </span>

      <span className="spacer" />

      <span className="statusbar-right">
        <DockToggles />
        {agentText ? (
          <button
            type="button"
            className={`status-cell status-link status-agent ${agentTone}`}
            title={`${kindName}: ${
              active.agentStartError
                ? active.agentStartError
                : active.agentExited
                  ? 'exited'
                  : (active.agentBridgeState ?? 'starting')
            }${active.agentPendingApproval ? ' — awaiting approval' : ''} — click to show`}
            onClick={() => {
              if (active.agentUiMode === 'hidden' || active.agentUiMode === 'floating') {
                void setAgentUiMode(active.id, 'docked', { kind })
              } else {
                const s = useSettings.getState()
                s.setTransfersPanelOpen(false)
                s.setAgentActivityCollapsed(false)
              }
            }}
          >
            {kindName}
            {' · '}
            {active.agentPendingApproval ? 'Approval needed' : agentText}
          </button>
        ) : (
          canStartAgent && (
            <button
              type="button"
              className="status-cell status-link status-agent"
              title={`Open ${kindName} in this pane`}
              onClick={() => {
                void setAgentUiMode(active.id, 'docked', {
                  kind,
                  title: active.context?.hostname ?? active.title
                })
              }}
            >
              {kindName}
            </button>
          )
        )}
      </span>
    </div>
  )
}
