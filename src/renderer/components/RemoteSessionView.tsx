import { memo, useEffect, useRef, useState } from 'react'
import type { PolicyMode } from '@shared/types'
import type { Session } from '../store/sessions'
import TerminalView from './TerminalView'
import SftpBrowser from './SftpBrowser'
import AgentPane from './AgentPane'
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
  const [agentWidth, setAgentWidth] = useState(480)
  const splitRef = useRef<HTMLDivElement>(null)

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
          title="What the in-app Pi agent is allowed to do on this host"
        >
          <span className="policy-label">Agent</span>
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
              : 'Launch the Pi agent for this host'
          }
          onClick={() => setAgentOpen((v) => !v)}
        >
          {agentOpen ? '✕ Close Pi' : '🤖 Pi'}
        </button>
      </div>

      <div className="view-body">
        {/* Layers hide with `visibility` (not display:none) so the shell keeps
            its real dimensions and stays fitted while the SFTP view is open —
            a display-hidden terminal is 0×0 and garbles on reveal. */}
        <div
          className="view-layer"
          style={{ visibility: view === 'terminal' ? undefined : 'hidden' }}
        >
          <div className="term-agent-split" ref={splitRef}>
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
                <AgentPane sessionId={session.id} mode={mode} />
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
