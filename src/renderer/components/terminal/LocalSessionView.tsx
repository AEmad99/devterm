import { memo, useEffect, useRef, useState } from 'react'
import type { AgentKind } from '@shared/types'
import { useSessions, type Session } from '../../store/sessions'
import { useSettings } from '../../store/settings'
import TerminalView from './TerminalView'
import AgentPane from '../agent/AgentPane'
import AgentAskBar from '../agent/AgentAskBar'
import AgentActivityPanel from '../agent/AgentActivityPanel'
import Splitter from '../common/Splitter'
import { AGENT_BRIDGE_POLICY } from '../../lib/agent-ui'
import { useBridgeActivity } from '../../lib/bridge-activity'

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))
const MIN_SHELL_WIDTH = 340
const MIN_AGENT_WIDTH = 320
const MAX_AGENT_WIDTH = 1200
const SPLITTER_WIDTH = 4

function fitAgentWidth(width: number, totalWidth: number): number {
  if (totalWidth <= 0) return clamp(width, MIN_AGENT_WIDTH, MAX_AGENT_WIDTH)
  const max = Math.min(
    MAX_AGENT_WIDTH,
    Math.max(180, totalWidth - MIN_SHELL_WIDTH - SPLITTER_WIDTH)
  )
  const min = Math.min(MIN_AGENT_WIDTH, max)
  return clamp(width, min, max)
}

/**
 * A local session: shell with the same agent affordances as remote sessions —
 * Ask bar under the shell as the launch surface, docked / floating / hidden
 * agent pane with process lifetime decoupled from layout. No SFTP/port-forward
 * surfaces (those are SSH concepts); everything else mirrors
 * RemoteSessionView's shell column and reuses its styles.
 */
function LocalSessionView({ session }: { session: Session }) {
  const [agentKind, setAgentKind] = useState<AgentKind>(
    () => session.agentKind ?? useSettings.getState().agentKind
  )
  const persistAgentKind = useSettings((s) => s.setAgentKind)
  const setAgentTask = useSessions((s) => s.setAgentTask)
  const agentActivityCollapsed = useSettings((s) => s.agentActivityCollapsed)
  const setAgentActivityCollapsed = useSettings((s) => s.setAgentActivityCollapsed)
  const agentUiMode = session.agentUiMode
  const agentAlive = !!agentUiMode
  const agentDocked = agentUiMode === 'docked'
  const [agentWidth, setAgentWidth] = useState(480)
  const splitRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (session.agentKind) setAgentKind(session.agentKind)
  }, [session.agentKind])

  // Mirror live bridge activity into the tab label, same as remote.
  // `latest` is derived from `entries`; depending on entries alone is
  // intentional — the effect only cares about the newest entry.
  const { entries } = useBridgeActivity(session.id)
  const latestRef = useRef(entries[entries.length - 1])
  latestRef.current = entries[entries.length - 1]
  useEffect(() => {
    const latest = latestRef.current
    if (!agentAlive || !latest) return
    if (latest.kind === 'tool_call') {
      setAgentTask(session.id, `${latest.tool}: ${latest.detail ?? ''}`.slice(0, 120), agentKind)
    } else if (latest.kind === 'approval_request') {
      setAgentTask(session.id, 'awaiting approval', agentKind)
    }
  }, [entries, agentAlive, session.id, agentKind, setAgentTask])

  return (
    <div className="remote-view">
      <div className="view-body">
        <div className="view-layer">
          <div className="term-agent-column" ref={splitRef}>
            <div className="term-agent-split">
              <div className="tc-term tc-term-with-ask">
                <div className="tc-term-shell">
                  <TerminalView session={session} />
                </div>
                <AgentAskBar
                  session={session}
                  kind={agentKind}
                  onKindChange={(k) => {
                    setAgentKind(k)
                    persistAgentKind(k)
                  }}
                  disabled={!!session.closed}
                />
              </div>
              {agentAlive && agentDocked && (
                <Splitter
                  direction="horizontal"
                  onDelta={(d) =>
                    setAgentWidth((w) => fitAgentWidth(w - d, splitRef.current?.clientWidth ?? 0))
                  }
                />
              )}
              {agentAlive && (
                <div
                  className={agentDocked ? 'tc-agent' : 'agent-ui-stash term-hidden'}
                  style={agentDocked ? { width: agentWidth } : undefined}
                  aria-hidden={!agentDocked}
                >
                  <AgentPane
                    sessionId={session.id}
                    kind={agentKind}
                    mode={AGENT_BRIDGE_POLICY}
                    active={agentDocked}
                    closeOnUnmount={false}
                    mirrorToStore
                  />
                </div>
              )}
            </div>
            {agentDocked && (
              <div
                className={`agent-activity-wrap ${agentActivityCollapsed ? 'is-collapsed' : ''}`}
              >
                <button
                  className="agent-activity-toggle"
                  onClick={() => setAgentActivityCollapsed(!agentActivityCollapsed)}
                  title={agentActivityCollapsed ? 'Show activity panel' : 'Hide activity panel'}
                  aria-expanded={!agentActivityCollapsed}
                >
                  <span className="agent-activity-toggle-glyph">
                    {agentActivityCollapsed ? '▴' : '▾'}
                  </span>
                  <span>{agentActivityCollapsed ? 'Activity' : 'Hide activity'}</span>
                </button>
                {!agentActivityCollapsed && (
                  <AgentActivityPanel
                    sessionId={session.id}
                    hostLabel={session.context?.hostname ?? 'this machine'}
                  />
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

export default memo(LocalSessionView)
