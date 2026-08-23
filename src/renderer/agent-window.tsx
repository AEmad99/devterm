import ReactDOM from 'react-dom/client'
import { useMemo } from 'react'
import type { AgentKind, PolicyMode } from '@shared/types'
import { useSettings } from './store/settings'
import { applyTheme, getTheme } from './lib/themes'
import AgentPane from './components/agent/AgentPane'
import ConfirmActionModal from './components/modals/ConfirmActionModal'
import { agentKindLabel, setAgentUiMode, stopAgent } from './lib/agent-ui'
import './styles.css'
import '@xterm/xterm/css/xterm.css'

applyTheme(getTheme(useSettings.getState().themeId))

function parseParams(): {
  sessionId: string
  kind: AgentKind
  mode: PolicyMode
  title: string
} {
  const q = new URLSearchParams(window.location.search)
  const kind = (q.get('kind') || 'devterm') as AgentKind
  const mode = (q.get('mode') || 'full') as PolicyMode
  return {
    sessionId: q.get('sessionId') || '',
    kind,
    mode,
    title: q.get('title') || ''
  }
}

function AgentFloatingApp() {
  const params = useMemo(() => parseParams(), [])
  const label = agentKindLabel(params.kind)

  if (!params.sessionId) {
    return (
      <div className="agent-float-root">
        <div className="agent-float-error">Missing session id for floating agent window.</div>
      </div>
    )
  }

  return (
    <div className="agent-float-root">
      <header className="agent-float-header">
        <div className="agent-float-title">
          <strong>{label}</strong>
          {params.title ? <span className="agent-float-host">{params.title}</span> : null}
        </div>
        <div className="agent-float-actions">
          <button
            type="button"
            className="ghost small"
            title="Dock the agent beside the terminal in the main window"
            onClick={() => {
              void setAgentUiMode(params.sessionId, 'docked', {
                kind: params.kind,
                title: params.title
              })
            }}
          >
            Dock
          </button>
          <button
            type="button"
            className="ghost small"
            title="Hide the agent UI; keep the process running"
            onClick={() => {
              void setAgentUiMode(params.sessionId, 'hidden', {
                kind: params.kind
              })
            }}
          >
            Hide
          </button>
          <button
            type="button"
            className="ghost small danger-text"
            title="Stop the agent process"
            onClick={() => {
              stopAgent(params.sessionId)
              window.close()
            }}
          >
            Stop
          </button>
        </div>
      </header>
      <div className="agent-float-body-pane">
        <AgentPane
          sessionId={params.sessionId}
          kind={params.kind}
          mode={params.mode}
          active
          closeOnUnmount={false}
          mirrorToStore={false}
        />
      </div>
      <ConfirmActionModal />
    </div>
  )
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(<AgentFloatingApp />)
