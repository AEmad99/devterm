import { useMemo, useState } from 'react'
import { useSessions } from '../../store/sessions'
import { useLayout, DEFAULT_GROUP } from '../../store/layout'
import {
  agentKindGlyph,
  agentKindLabel,
  restartAgent,
  setAgentUiMode,
  stopAgent
} from '../../lib/agent-ui'
import { delegateFromCockpit } from '../../lib/agent-handoff'
import { focusTerminal } from '../../lib/terms'
import ModalShell from '../common/ModalShell'
import Button from '../common/Button'
import {
  IconAgent,
  IconAgentFloat,
  IconAgentShow,
  IconAgentStop,
  IconRefresh
} from '../common/Icons'

/** One-line status for the overview list. */
function agentStateLabel(
  mode: string | undefined,
  bridge: string | undefined,
  exited: boolean,
  startError?: string
): string {
  if (startError) return 'failed'
  if (exited) return 'exited'
  if (mode === 'hidden') return 'hidden'
  if (mode === 'floating') return 'floating'
  if (mode === 'docked') return 'docked'
  switch (bridge) {
    case 'connected':
      return 'idle'
    case 'listening':
      return 'waiting'
    case 'starting':
      return 'starting'
    case 'disconnected':
      return 'disconnected'
    case 'stopped':
      return 'stopped'
    case 'error':
      return 'error'
    default:
      return 'running'
  }
}

function ageLabel(startedAt?: number): string {
  if (!startedAt) return ''
  const sec = Math.max(0, Math.round((Date.now() - startedAt) / 1000))
  if (sec < 60) return `${sec}s`
  const min = Math.round(sec / 60)
  if (min < 60) return `${min}m`
  return `${Math.round(min / 60)}h`
}

function hostLabel(s: { kind?: string; title?: string; context?: { hostname?: string } }): string {
  if (s.kind === 'local') return 'local'
  return s.context?.hostname || s.title || 'remote'
}

/**
 * Agent cockpit: every live agent in one list with its host, state, last task,
 * and the actions that used to require hunting for the right tab (show, float,
 * restart, stop). Opened from the pane cluster, palette, or Ctrl/Cmd+Alt+A.
 */
export default function AgentsOverviewModal({
  open,
  onClose
}: {
  open: boolean
  onClose: () => void
}) {
  const sessions = useSessions((s) => s.sessions)
  const [delegateFor, setDelegateFor] = useState<string | null>(null)
  const [delegateTask, setDelegateTask] = useState('')
  const agents = useMemo(
    () =>
      sessions
        .filter((s) => s.agentUiMode && !s.closed)
        .sort((a, b) => a.title.localeCompare(b.title)),
    [sessions]
  )

  const focusSession = (sid: string) => {
    const s = useSessions.getState().sessions.find((x) => x.id === sid)
    if (!s) return
    const gid = s.groupId ?? DEFAULT_GROUP
    useLayout.getState().setActiveGroup(gid)
    useSessions.getState().setActive(sid)
    focusTerminal(sid)
    onClose()
  }

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      title={agents.length ? `Agents (${agents.length})` : 'Agents'}
      size="md"
    >
      {agents.length === 0 ? (
        <div className="agents-empty">
          Open an agent from a terminal's pane tab strip (the sparkle button), or from the command
          palette. Hidden and floating agents keep running and appear here.
        </div>
      ) : (
        <ul className="agents-list">
          {agents.map((s) => {
            const pending = !!s.agentPendingApproval
            const mode = s.agentUiMode
            return (
              <li key={s.id} className={`agents-row${pending ? ' has-pending' : ''}`}>
                <span className="agents-row-icon">
                  <IconAgent size={15} />
                </span>
                <button
                  className="agents-row-main"
                  onClick={() => focusSession(s.id)}
                  title="Focus this session"
                >
                  <span className="agents-row-title">
                    {s.title}
                    {pending && <span className="agents-row-badge">approval</span>}
                    {s.agentStartError && <span className="agents-row-badge is-error">failed</span>}
                    {s.agentExited && !s.agentStartError && (
                      <span className="agents-row-badge is-error">exited</span>
                    )}
                  </span>
                  <span className="agents-row-meta">
                    {s.agentStartError || s.agentTask || 'no current task'} ·{' '}
                    {s.agentStartError ? 'failed' : s.agentExited ? 'exited' : 'running'} ·{' '}
                    {s.cwd || 'cwd unknown'} · {hostLabel(s)} ·{' '}
                    {agentKindGlyph(s.agentKind ?? 'devterm')} · {ageLabel(s.agentStartedAt)} ·{' '}
                    {agentStateLabel(mode, s.agentBridgeState, !!s.agentExited, s.agentStartError)}
                  </span>
                  <span
                    className="agents-row-kind"
                    title={agentKindLabel(s.agentKind ?? 'devterm')}
                  >
                    {agentKindGlyph(s.agentKind ?? 'devterm')}
                  </span>
                </button>
                <div className="agents-row-actions">
                  <button
                    className="icon-btn"
                    title="Focus pane"
                    onClick={() => focusSession(s.id)}
                  >
                    Focus
                  </button>
                  {s.kind === 'local' && (
                    <button
                      className="icon-btn"
                      title="Delegate to a sibling local agent"
                      onClick={() => {
                        setDelegateFor(s.id)
                        setDelegateTask('')
                      }}
                    >
                      Delegate
                    </button>
                  )}
                  {mode !== 'docked' && (
                    <button
                      className="icon-btn"
                      title="Show in pane"
                      onClick={() => void setAgentUiMode(s.id, 'docked', { kind: s.agentKind })}
                    >
                      <IconAgentShow size={14} />
                    </button>
                  )}
                  {mode !== 'floating' && (
                    <button
                      className="icon-btn"
                      title="Float in a separate window"
                      onClick={() => void setAgentUiMode(s.id, 'floating', { kind: s.agentKind })}
                    >
                      <IconAgentFloat size={14} />
                    </button>
                  )}
                  <button
                    className="icon-btn"
                    title="Restart the agent"
                    onClick={() => restartAgent(s.id)}
                  >
                    <IconRefresh size={13} />
                  </button>
                  <button
                    className="icon-btn danger"
                    title="Stop the agent"
                    onClick={() => stopAgent(s.id)}
                  >
                    <IconAgentStop size={12} />
                  </button>
                </div>
                {delegateFor === s.id && (
                  <form
                    className="agents-delegate"
                    onSubmit={(e) => {
                      e.preventDefault()
                      if (!delegateTask.trim()) return
                      delegateFromCockpit(s.id, delegateTask)
                      setDelegateFor(null)
                      setDelegateTask('')
                    }}
                  >
                    <label>
                      Task for the delegated agent
                      <textarea
                        autoFocus
                        value={delegateTask}
                        rows={3}
                        onChange={(e) => setDelegateTask(e.target.value)}
                      />
                    </label>
                    <div className="agents-delegate-actions">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setDelegateFor(null)}
                      >
                        Cancel
                      </Button>
                      <Button
                        type="submit"
                        variant="primary"
                        size="sm"
                        disabled={!delegateTask.trim()}
                      >
                        Start
                      </Button>
                    </div>
                  </form>
                )}
              </li>
            )
          })}
        </ul>
      )}
      <div className="agents-footer">
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>
    </ModalShell>
  )
}
