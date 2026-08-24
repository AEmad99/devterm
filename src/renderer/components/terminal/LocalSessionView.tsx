import { memo, useEffect, useState } from 'react'
import type { AgentKind } from '@shared/types'
import { useSessions, type Session } from '../../store/sessions'
import { useSettings } from '../../store/settings'
import TerminalView from './TerminalView'
import AgentPane from '../agent/AgentPane'
import { AGENT_BRIDGE_POLICY } from '../../lib/agent-ui'
import { useBridgeActivity } from '../../lib/bridge-activity'

/**
 * A local session: the shell is a normal PTY. Open Agent lives on the pane
 * tab strip (icon cluster). The agent occupies this pane — not a side split,
 * not an ask bar. The shell stays mounted and hidden so its PTY survives Stop.
 */
function LocalSessionView({ session }: { session: Session }) {
  const [agentKind, setAgentKind] = useState<AgentKind>(
    () => session.agentKind ?? useSettings.getState().agentKind
  )
  const setAgentTask = useSessions((s) => s.setAgentTask)
  const agentUiMode = session.agentUiMode
  const agentAlive = !!agentUiMode
  const agentDocked = agentUiMode === 'docked'

  useEffect(() => {
    if (session.agentKind) setAgentKind(session.agentKind)
  }, [session.agentKind])

  const { entries } = useBridgeActivity(session.id)
  useEffect(() => {
    if (!agentAlive) return
    const latest = entries[entries.length - 1]
    if (!latest) return
    if (latest.kind === 'tool_call') {
      setAgentTask(session.id, `${latest.tool}: ${latest.detail ?? ''}`.slice(0, 120), agentKind)
    } else if (latest.kind === 'approval_request') {
      setAgentTask(session.id, 'awaiting approval', agentKind)
    } else if (latest.kind === 'approval_outcome') {
      setAgentTask(session.id, latest.ok ? 'approval granted' : 'approval denied', agentKind)
    }
  }, [entries, agentAlive, session.id, agentKind, setAgentTask])

  return (
    <div className="remote-view">
      <div className="view-body">
        <div className={`view-layer${agentDocked ? ' term-hidden' : ''}`}>
          <TerminalView session={session} />
        </div>
        {agentAlive && (
          <div
            className={agentDocked ? 'view-layer' : 'agent-ui-stash term-hidden'}
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
    </div>
  )
}

export default memo(LocalSessionView)
