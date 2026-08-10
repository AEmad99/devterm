import { memo, useCallback, useEffect, useRef, useState } from 'react'
import type { AgentKind, PolicyMode } from '@shared/types'
import { useSessions, type Session } from '../../store/sessions'
import { useSettings } from '../../store/settings'
import TerminalView from './TerminalView'
import SftpBrowser from '../files/SftpBrowser'
import AgentPane from '../agent/AgentPane'
import AgentAskBar from '../agent/AgentAskBar'
import AgentActivityPanel from '../agent/AgentActivityPanel'
import Splitter from '../common/Splitter'
import PortForwardPanel from './PortForwardPanel'
import {
  agentKindLabel,
  ensureAgent,
  setAgentUiMode,
  stopAgent
} from '../../lib/agent-ui'
import { useBridgeActivity } from '../../lib/bridge-activity'

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

function formatAgentTabTask(tool: string | undefined, detail: string | undefined): string {
  const d = (detail ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!tool) return d
  if (!d) return tool
  const commandEq = d.match(/(?:^|\s)command=([\s\S]+)$/)
  if (commandEq) {
    const cmd = commandEq[1].replace(/\s+\w[\w]*=\S+\s*$/, '').trim()
    return `${tool}: ${cmd}`
  }
  const pathEq = d.match(/(?:^|\s)path=(\S+)/)
  if (pathEq) return `${tool}: ${pathEq[1]}`
  const firstKv = d.match(/^([a-zA-Z_][\w]*)=(.*)$/)
  if (firstKv) return `${tool}: ${firstKv[2]}`
  return `${tool}: ${d}`
}

/**
 * A remote session: shell or SFTP browser, with an optional agent session in
 * one of three UI modes — docked side column, floating OS window, or hidden
 * (process keeps running). An Ask bar under the shell can start/inject prompts
 * without permanently stealing terminal estate.
 */
function RemoteSessionView({ session }: { session: Session }) {
  const [view, setView] = useState<'terminal' | 'files' | 'ports'>('terminal')
  const [filesOpened, setFilesOpened] = useState(false)
  const [portsOpened, setPortsOpened] = useState(false)
  // Prefer store-backed kind/policy once the agent is running so float/hide
  // round-trips keep the same backend.
  const [mode, setMode] = useState<PolicyMode>(() => session.agentPolicyMode ?? 'full')
  const [agentKind, setAgentKind] = useState<AgentKind>(
    () => session.agentKind ?? useSettings.getState().agentKind
  )
  const persistAgentKind = useSettings((s) => s.setAgentKind)
  const agentUiMode = session.agentUiMode
  const agentAlive = !!agentUiMode
  const agentDocked = agentUiMode === 'docked'
  const agentLabel = agentKindLabel(agentKind)
  const [agentWidth, setAgentWidth] = useState(480)
  const [filesSideOpen, setFilesSideOpen] = useState(false)
  const [filesWidth, setFilesWidth] = useState(420)
  const [starting, setStarting] = useState(false)
  const splitRef = useRef<HTMLDivElement>(null)
  const filesSplitRef = useRef<HTMLDivElement>(null)
  const sftpSidePane = useSettings((s) => s.sftpSidePane)
  const setSftpSidePane = useSettings((s) => s.setSftpSidePane)
  const cancelSshReconnect = useSessions((s) => s.cancelSshReconnect)
  const setAgentUi = useSessions((s) => s.setAgentUi)
  const setAgentTask = useSessions((s) => s.setAgentTask)
  const agentActivityCollapsed = useSettings((s) => s.agentActivityCollapsed)
  const setAgentActivityCollapsed = useSettings((s) => s.setAgentActivityCollapsed)
  const status = session.status
  const showReconnectBanner =
    status?.startsWith('reconnecting…') ||
    status === 'reconnect cancelled' ||
    status?.startsWith('reconnect failed')

  // Sync local pickers from store when another surface (ask bar / float) sets them.
  useEffect(() => {
    if (session.agentKind) setAgentKind(session.agentKind)
  }, [session.agentKind])
  useEffect(() => {
    if (session.agentPolicyMode) setMode(session.agentPolicyMode)
  }, [session.agentPolicyMode])

  // Keep tab task labels fresh even when the agent pane is hidden/floating.
  const { entries } = useBridgeActivity(session.id)
  useEffect(() => {
    if (!agentAlive) return
    const latest = entries[entries.length - 1]
    if (!latest) return
    if (latest.kind === 'tool_call') {
      setAgentTask(session.id, formatAgentTabTask(latest.tool, latest.detail), agentKind)
    } else if (latest.kind === 'approval_request') {
      setAgentTask(session.id, 'awaiting approval', agentKind)
    } else if (latest.kind === 'approval_outcome') {
      setAgentTask(session.id, latest.ok ? 'approval granted' : 'approval denied', agentKind)
    }
  }, [entries, agentAlive, session.id, agentKind, setAgentTask])

  useEffect(() => {
    if (!agentDocked) return
    const el = splitRef.current
    if (!el) return
    const fit = () => setAgentWidth((w) => fitAgentWidth(w, el.clientWidth))
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [agentDocked])

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

  const hostTitle = session.context?.hostname ?? session.title
  const canStart = !!session.context && !session.closed && !starting

  const startDocked = useCallback(async () => {
    if (!canStart) return
    setStarting(true)
    try {
      await ensureAgent({
        sessionId: session.id,
        kind: agentKind,
        mode,
        cwd: session.cwd,
        uiMode: 'docked'
      })
    } catch {
      /* AgentPane / status pill will surface errors if mount follows */
      setAgentUi(session.id, { mode: 'docked', kind: agentKind, policyMode: mode })
    } finally {
      setStarting(false)
    }
  }, [canStart, session.id, session.cwd, agentKind, mode, setAgentUi])

  const onStop = useCallback(() => {
    stopAgent(session.id)
  }, [session.id])

  const onHide = useCallback(() => {
    void setAgentUiMode(session.id, 'hidden', { kind: agentKind, policyMode: mode })
  }, [session.id, agentKind, mode])

  const onDock = useCallback(() => {
    void setAgentUiMode(session.id, 'docked', {
      kind: agentKind,
      policyMode: mode,
      title: hostTitle
    })
  }, [session.id, agentKind, mode, hostTitle])

  const onFloat = useCallback(async () => {
    if (!agentAlive) {
      setStarting(true)
      try {
        await ensureAgent({
          sessionId: session.id,
          kind: agentKind,
          mode,
          cwd: session.cwd,
          uiMode: 'floating'
        })
      } finally {
        setStarting(false)
      }
    }
    await setAgentUiMode(session.id, 'floating', {
      kind: agentKind,
      policyMode: mode,
      title: hostTitle
    })
  }, [agentAlive, session.id, session.cwd, agentKind, mode, hostTitle])

  const locked = agentAlive

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
          title="DevTerm Agent is the embedded multi-provider default. External CLIs are fallbacks. Every agent acts on this host only through DevTerm's MCP bridge."
        >
          <span className="policy-label">Agent</span>
          <select
            className="policy-select"
            value={agentKind}
            disabled={locked}
            onChange={(e) => {
              const next = e.target.value as AgentKind
              setAgentKind(next)
              persistAgentKind(next)
            }}
          >
            <optgroup label="Built in">
              <option value="devterm">DevTerm Agent (all providers)</option>
            </optgroup>
            <optgroup label="External CLI fallbacks">
              <option value="claude">Claude</option>
              <option value="pi">Pi</option>
              <option value="opencode">OpenCode</option>
              <option value="kimi">Kimi</option>
              <option value="grok">Grok</option>
              <option value="codex">Codex</option>
              <option value="antigravity">Antigravity (agy)</option>
            </optgroup>
          </select>
        </label>
        <label className="policy-field" title="What the in-app agent is allowed to do on this host">
          <span className="policy-label">Policy</span>
          <select
            className="policy-select"
            value={mode}
            disabled={locked}
            onChange={(e) => setMode(e.target.value as PolicyMode)}
          >
            <option value="read_only">Read-only</option>
            <option value="confirm">Ask before changes</option>
            <option value="full">Bypass permissions</option>
          </select>
        </label>

        {!agentAlive ? (
          <button
            className={`agent-btn ${session.agentPendingApproval ? 'has-pending' : ''}`}
            disabled={!canStart}
            title={
              !session.context
                ? 'Connect the SSH session first'
                : `Launch the ${agentLabel} agent for this host`
            }
            onClick={() => void startDocked()}
          >
            {starting ? 'Starting…' : `🤖 Open ${agentLabel}`}
            {session.agentPendingApproval && <span className="agent-pending-dot" />}
          </button>
        ) : (
          <div className="agent-mode-btns">
            {agentUiMode === 'hidden' && (
              <button
                className="agent-btn agent-btn-secondary"
                title="Show the agent docked beside the terminal"
                onClick={onDock}
              >
                Show
              </button>
            )}
            {agentUiMode === 'floating' && (
              <button
                className="agent-btn agent-btn-secondary"
                title="Dock the agent beside the terminal"
                onClick={onDock}
              >
                Dock
              </button>
            )}
            {agentUiMode === 'docked' && (
              <button
                className="agent-btn agent-btn-secondary"
                title="Hide the agent panel; keep the process running"
                onClick={onHide}
              >
                Hide
              </button>
            )}
            {agentUiMode !== 'floating' && (
              <button
                className="agent-btn agent-btn-secondary"
                title="Pop the agent out into a floating OS window"
                onClick={() => void onFloat()}
              >
                Float
              </button>
            )}
            <button
              className={`agent-btn active ${session.agentPendingApproval ? 'has-pending' : ''}`}
              title={`Stop the ${agentLabel} agent`}
              onClick={onStop}
            >
              ✕ Stop
              {session.agentPendingApproval && <span className="agent-pending-dot" />}
            </button>
            {agentUiMode && agentUiMode !== 'docked' && (
              <span
                className={`agent-ui-chip agent-ui-chip--${agentUiMode}`}
                title={
                  agentUiMode === 'floating'
                    ? 'Agent is in a floating window'
                    : 'Agent is running hidden — use Show or the ask bar'
                }
              >
                {agentUiMode}
                {session.agentTask ? ` · ${session.agentTask}` : ''}
              </span>
            )}
          </div>
        )}
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
                <div className="tc-term tc-term-with-ask">
                  <div className="tc-term-shell">
                    <TerminalView session={session} />
                  </div>
                  <AgentAskBar
                    session={session}
                    kind={agentKind}
                    mode={mode}
                    onKindChange={(k) => {
                      setAgentKind(k)
                      persistAgentKind(k)
                    }}
                    onModeChange={setMode}
                    disabled={!session.context || !!session.closed}
                  />
                </div>
                {/* Keep AgentPane mounted while the process is alive so scrollback
                    survives hide/float. Only the docked mode sizes it into the layout;
                    otherwise it is stashed off-screen and marked inactive. */}
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
                      mode={mode}
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
        {filesOpened && !filesSideOpen && (
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
