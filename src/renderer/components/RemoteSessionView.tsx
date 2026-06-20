import { memo, useEffect, useRef, useState } from 'react'
import type { AgentKind, PolicyMode } from '@shared/types'
import { useSessions, type Session } from '../store/sessions'
import { useSettings } from '../store/settings'
import TerminalView from './TerminalView'
import SftpBrowser from './SftpBrowser'
import AgentPane from './AgentPane'
import AgentActivityPanel from './AgentActivityPanel'
import Splitter from './Splitter'

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
 * A remote session: shell or SFTP browser, with an optional agent pane
 * docked beside the shell (resizable). The terminal stays mounted so its shell
 * channel survives view switches.
 */
function RemoteSessionView({ session }: { session: Session }) {
  const [view, setView] = useState<'terminal' | 'files'>('terminal')
  const [filesOpened, setFilesOpened] = useState(false)
  const [agentOpen, setAgentOpen] = useState(false)
  const [mode, setMode] = useState<PolicyMode>('full')
  // Seed the agent choice from the persisted "last used" setting, kept as local
  // state so it stays fixed for an open pane and another remote session changing
  // its picker can't restart this one. Changing it here writes back to settings
  // so the choice is remembered next launch.
  const [agentKind, setAgentKind] = useState<AgentKind>(() => useSettings.getState().agentKind)
  const persistAgentKind = useSettings((s) => s.setAgentKind)
  const agentLabel = agentKind === 'claude' ? 'Claude' : agentKind === 'opencode' ? 'OpenCode' : 'Pi'
  const [agentWidth, setAgentWidth] = useState(480)
  const splitRef = useRef<HTMLDivElement>(null)
  const cancelSshReconnect = useSessions((s) => s.cancelSshReconnect)
  const agentActivityCollapsed = useSettings((s) => s.agentActivityCollapsed)
  const setAgentActivityCollapsed = useSettings((s) => s.setAgentActivityCollapsed)
  const status = session.status
  // Show a banner only for the transient reconnecting state and the
  // permanent-failure state. A "reconnect cancelled" / "reconnected" status
  // is left to clear itself on the next event.
  const showReconnectBanner =
    status?.startsWith('reconnecting…') ||
    status === 'reconnect cancelled' ||
    status?.startsWith('reconnect failed')

  useEffect(() => {
    if (!agentOpen) return
    const el = splitRef.current
    if (!el) return
    const fit = () => setAgentWidth((w) => fitAgentWidth(w, el.clientWidth))
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [agentOpen])

  return (
    <div className="remote-view">
      {showReconnectBanner && (
        <div
          className={`reconnect-banner ${
            status?.startsWith('reconnect failed') ? 'is-failed' : ''
          }`}
        >
          <span className="reconnect-banner-text">{status}</span>
          {status?.startsWith('reconnecting…') && (
            <button
              className="ghost small"
              onClick={() => cancelSshReconnect(session.id)}
              title="Stop trying to reconnect"
            >
              Cancel
            </button>
          )}
          {status?.startsWith('reconnect failed') && (
            <span
              className="reconnect-banner-hint"
              title="Close this tab and re-open from the saved connection"
            >
              Close this tab and re-open from the saved connection.
            </span>
          )}
        </div>
      )}
      <div className="view-toggle">
        <button className={view === 'terminal' ? 'active' : ''} onClick={() => setView('terminal')}>
          Terminal
        </button>
        <button
          className={view === 'files' ? 'active' : ''}
          onClick={() => {
            setView('files')
            setFilesOpened(true)
          }}
        >
          Files (SFTP)
        </button>

        <span className="vt-spacer" />

        <label
          className="policy-field"
          title="Which coding agent to launch for this host. Claude is Anthropic-only; Pi reaches more models and subscriptions; OpenCode (sst/opencode) is the TUI agent with the broadest provider reach. All three act on this host only through DevTerm's MCP bridge."
        >
          <span className="policy-label">Agent</span>
          <select
            className="policy-select"
            value={agentKind}
            disabled={agentOpen}
            onChange={(e) => {
              const next = e.target.value as AgentKind
              setAgentKind(next)
              persistAgentKind(next)
            }}
          >
            <option value="claude">Claude</option>
            <option value="pi">Pi</option>
            <option value="opencode">OpenCode</option>
          </select>
        </label>
        <label
          className="policy-field"
          title="What the in-app agent is allowed to do on this host"
        >
          <span className="policy-label">Policy</span>
          <select
            className="policy-select"
            value={mode}
            disabled={agentOpen}
            onChange={(e) => setMode(e.target.value as PolicyMode)}
          >
            <option value="read_only">Read-only</option>
            <option value="confirm">Ask before changes</option>
            <option value="full">Bypass permissions</option>
          </select>
        </label>
        <button
          className={`agent-btn ${agentOpen ? 'active' : ''}`}
          disabled={!agentOpen && (!session.context || !!session.closed)}
          title={
            !session.context
              ? 'Connect the SSH session first'
              : `Launch the ${agentLabel} agent for this host`
          }
          onClick={() => setAgentOpen((v) => !v)}
        >
          {agentOpen ? `✕ Close ${agentLabel}` : `🤖 Open ${agentLabel}`}
        </button>
      </div>

      <div className="view-body">
        {/* The shell layer hides via `.term-hidden` (visibility:hidden + an
            off-screen translate), never display:none: it keeps its real
            dimensions so the shell stays fitted and doesn't garble on reveal,
            and going off-screen makes xterm pause the shell + agent render loops
            while the SFTP view is open. */}
        <div className={`view-layer${view === 'terminal' ? '' : ' term-hidden'}`}>
          <div className="term-agent-column" ref={splitRef}>
            <div className="term-agent-split">
              <div className="tc-term">
                <TerminalView session={session} />
              </div>
              {agentOpen && (
                <Splitter
                  direction="horizontal"
                  onDelta={(d) =>
                    setAgentWidth((w) => fitAgentWidth(w - d, splitRef.current?.clientWidth ?? 0))
                  }
                />
              )}
              {agentOpen && (
                <div className="tc-agent" style={{ width: agentWidth }}>
                  <AgentPane sessionId={session.id} kind={agentKind} mode={mode} />
                </div>
              )}
            </div>
            {agentOpen && (
              <div className={`agent-activity-wrap ${agentActivityCollapsed ? 'is-collapsed' : ''}`}>
                <button
                  className="agent-activity-toggle"
                  onClick={() => setAgentActivityCollapsed(!agentActivityCollapsed)}
                  title={agentActivityCollapsed ? 'Show activity panel' : 'Hide activity panel'}
                  aria-expanded={!agentActivityCollapsed}
                >
                  <span className="agent-activity-toggle-glyph">
                    {agentActivityCollapsed ? '▴' : '▾'}
                  </span>
                  <span>
                    {agentActivityCollapsed ? 'Activity' : 'Hide activity'}
                  </span>
                </button>
                {!agentActivityCollapsed && (
                  <AgentActivityPanel
                    sessionId={session.id}
                    hostLabel={session.context?.hostname ?? session.title}
                  />
                )}
              </div>
            )}
          </div>
        </div>
        {filesOpened && (
          <div
            className="view-layer"
            style={{ visibility: view === 'files' ? undefined : 'hidden' }}
          >
            <SftpBrowser sessionId={session.id} />
          </div>
        )}
      </div>
    </div>
  )
}

// Memoized like the other panes so a layout drag/resize tick can't re-render the
// remote shell + SFTP + agent subtree; it only depends on its stable session.
export default memo(RemoteSessionView)
