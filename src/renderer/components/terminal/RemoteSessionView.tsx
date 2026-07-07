import { memo, useEffect, useRef, useState } from 'react'
import type { AgentKind, PolicyMode } from '@shared/types'
import { useSessions, type Session } from '../../store/sessions'
import { useSettings } from '../../store/settings'
import TerminalView from './TerminalView'
import SftpBrowser from '../files/SftpBrowser'
import AgentPane from '../agent/AgentPane'
import AgentActivityPanel from '../agent/AgentActivityPanel'
import Splitter from '../common/Splitter'
import PortForwardPanel from './PortForwardPanel'

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))
const MIN_SHELL_WIDTH = 340
const MIN_AGENT_WIDTH = 320
const MAX_AGENT_WIDTH = 1200
const MIN_FILES_WIDTH = 280
const MAX_FILES_WIDTH = 900
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

function fitFilesWidth(width: number, totalWidth: number): number {
  if (totalWidth <= 0) return clamp(width, MIN_FILES_WIDTH, MAX_FILES_WIDTH)
  const max = Math.min(
    MAX_FILES_WIDTH,
    Math.max(MIN_FILES_WIDTH, totalWidth - MIN_SHELL_WIDTH - SPLITTER_WIDTH)
  )
  const min = Math.min(MIN_FILES_WIDTH, max)
  return clamp(width, min, max)
}

/**
 * A remote session: shell or SFTP browser, with an optional agent pane
 * docked beside the shell (resizable). The terminal stays mounted so its shell
 * channel survives view switches.
 */
function RemoteSessionView({ session }: { session: Session }) {
  const [view, setView] = useState<'terminal' | 'files' | 'ports'>('terminal')
  const [filesOpened, setFilesOpened] = useState(false)
  const [portsOpened, setPortsOpened] = useState(false)
  const [agentOpen, setAgentOpen] = useState(false)
  const [mode, setMode] = useState<PolicyMode>('full')
  // Seed the agent choice from the persisted "last used" setting, kept as local
  // state so it stays fixed for an open pane and another remote session changing
  // its picker can't restart this one. Changing it here writes back to settings
  // so the choice is remembered next launch.
  const [agentKind, setAgentKind] = useState<AgentKind>(() => useSettings.getState().agentKind)
  const persistAgentKind = useSettings((s) => s.setAgentKind)
  const agentLabel =
    agentKind === 'claude'
      ? 'Claude'
      : agentKind === 'opencode'
        ? 'OpenCode'
        : agentKind === 'kimi'
          ? 'Kimi'
          : agentKind === 'grok'
            ? 'Grok'
            : agentKind === 'codex'
              ? 'Codex'
              : 'Pi'
  const [agentWidth, setAgentWidth] = useState(480)
  const [filesSideOpen, setFilesSideOpen] = useState(false)
  const [filesWidth, setFilesWidth] = useState(420)
  const splitRef = useRef<HTMLDivElement>(null)
  const filesSplitRef = useRef<HTMLDivElement>(null)
  const sftpSidePane = useSettings((s) => s.sftpSidePane)
  const setSftpSidePane = useSettings((s) => s.setSftpSidePane)
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

  useEffect(() => {
    if (!filesSideOpen) return
    const el = filesSplitRef.current
    if (!el) return
    const fit = () => setFilesWidth((w) => fitFilesWidth(w, el.clientWidth))
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [filesSideOpen])

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
          className={
            (!sftpSidePane && view === 'files') || (sftpSidePane && filesSideOpen) ? 'active' : ''
          }
          onClick={() => {
            if (sftpSidePane) {
              setFilesSideOpen((v) => !v)
            } else {
              setView('files')
              setFilesOpened(true)
            }
          }}
        >
          Files (SFTP)
        </button>
        <button
          className={`side-pane-toggle ${sftpSidePane ? 'active' : ''}`}
          title={
            sftpSidePane
              ? 'SFTP opens docked beside the terminal'
              : 'SFTP opens as a full-pane view'
          }
          onClick={() => setSftpSidePane(!sftpSidePane)}
        >
          Side
        </button>
        <button
          className={view === 'ports' ? 'active' : ''}
          onClick={() => {
            setView('ports')
            setPortsOpened(true)
          }}
        >
          Ports
        </button>

        <span className="vt-spacer" />

        <label
          className="policy-field"
          title="Which coding agent to launch for this host. Claude is Anthropic-only; Pi reaches more models and subscriptions; OpenCode (sst/opencode), Kimi (kimi-cli), Grok (xAI Grok CLI), and Codex (OpenAI Codex CLI) are TUI agents with broad provider reach. All six act on this host only through DevTerm's MCP bridge."
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
            <option value="kimi">Kimi</option>
            <option value="grok">Grok</option>
            <option value="codex">Codex</option>
          </select>
        </label>
        <label className="policy-field" title="What the in-app agent is allowed to do on this host">
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
          className={`agent-btn ${agentOpen ? 'active' : ''} ${session.agentPendingApproval ? 'has-pending' : ''}`}
          disabled={!agentOpen && (!session.context || !!session.closed)}
          title={
            !session.context
              ? 'Connect the SSH session first'
              : session.agentPendingApproval
                ? `${agentLabel} is waiting for approval`
                : `Launch the ${agentLabel} agent for this host`
          }
          onClick={() => setAgentOpen((v) => !v)}
        >
          {agentOpen ? `✕ Close ${agentLabel}` : `🤖 Open ${agentLabel}`}
          {session.agentPendingApproval && <span className="agent-pending-dot" />}
        </button>
      </div>

      <div className="view-body">
        {/* The shell layer hides via `.term-hidden` (visibility:hidden + an
            off-screen translate), never display:none: it keeps its real
            dimensions so the shell stays fitted and doesn't garble on reveal,
            and going off-screen makes xterm pause the shell + agent render loops
            while the SFTP view is open. */}
        <div className={`view-layer${view === 'terminal' ? '' : ' term-hidden'}`}>
          <div className="term-files-split" ref={filesSplitRef}>
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
                      hostLabel={session.context?.hostname ?? session.title}
                    />
                  )}
                </div>
              )}
            </div>
            {filesSideOpen && (
              <Splitter
                direction="horizontal"
                onDelta={(d) =>
                  setFilesWidth((w) =>
                    fitFilesWidth(w - d, filesSplitRef.current?.clientWidth ?? 0)
                  )
                }
              />
            )}
            {filesSideOpen && (
              <div className="remote-side-pane" style={{ width: filesWidth }}>
                <SftpBrowser sessionId={session.id} />
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
        {portsOpened && (
          <div
            className="view-layer"
            style={{ visibility: view === 'ports' ? undefined : 'hidden' }}
          >
            <PortForwardPanel sessionId={session.id} />
          </div>
        )}
      </div>
    </div>
  )
}

// Memoized like the other panes so a layout drag/resize tick can't re-render the
// remote shell + SFTP + agent subtree; it only depends on its stable session.
export default memo(RemoteSessionView)
