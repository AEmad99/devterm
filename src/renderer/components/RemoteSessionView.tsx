import { memo, useState } from 'react'
import type { PolicyMode } from '@shared/types'
import type { Session } from '../store/sessions'
import TerminalView from './TerminalView'
import SftpBrowser from './SftpBrowser'
import ClaudePane from './ClaudePane'
import Splitter from './Splitter'

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))

/**
 * A remote session: shell or SFTP browser, with an optional Claude agent pane
 * docked beside the shell (resizable). The terminal stays mounted so its shell
 * channel survives view switches.
 */
function RemoteSessionView({ session }: { session: Session }) {
  const [view, setView] = useState<'terminal' | 'files'>('terminal')
  const [filesOpened, setFilesOpened] = useState(false)
  const [claudeOpen, setClaudeOpen] = useState(false)
  const [mode, setMode] = useState<PolicyMode>('confirm')
  const [claudeWidth, setClaudeWidth] = useState(480)

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
          title="What the in-app Claude agent is allowed to do on this host"
        >
          <span className="policy-label">Agent</span>
          <select
            className="policy-select"
            value={mode}
            disabled={claudeOpen}
            onChange={(e) => setMode(e.target.value as PolicyMode)}
          >
            <option value="read_only">Read-only</option>
            <option value="confirm">Ask before changes</option>
            <option value="full">Full access</option>
          </select>
        </label>
        <button
          className={`claude-btn ${claudeOpen ? 'active' : ''}`}
          disabled={!claudeOpen && (!session.context || !!session.closed)}
          title={
            !session.context
              ? 'Connect the SSH session first'
              : 'Launch the Claude agent for this host'
          }
          onClick={() => setClaudeOpen((v) => !v)}
        >
          {claudeOpen ? '✕ Close Claude' : '🤖 Claude'}
        </button>
      </div>

      <div className="view-body">
        <div className="view-layer" style={{ display: view === 'terminal' ? 'block' : 'none' }}>
          <div className="term-claude-split">
            <div className="tc-term">
              <TerminalView session={session} />
            </div>
            {claudeOpen && (
              <Splitter direction="horizontal" onDelta={(d) => setClaudeWidth((w) => clamp(w - d, 280, 1200))} />
            )}
            {claudeOpen && (
              <div className="tc-claude" style={{ width: claudeWidth }}>
                <ClaudePane sessionId={session.id} mode={mode} />
              </div>
            )}
          </div>
        </div>
        {filesOpened && (
          <div className="view-layer" style={{ display: view === 'files' ? 'block' : 'none' }}>
            <SftpBrowser sessionId={session.id} />
          </div>
        )}
      </div>
    </div>
  )
}

// Memoized like the other panes so a layout drag/resize tick can't re-render the
// remote shell + SFTP + Claude subtree; it only depends on its stable session.
export default memo(RemoteSessionView)
