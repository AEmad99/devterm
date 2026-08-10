import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentKind, PolicyMode } from '@shared/types'
import type { Session } from '../../store/sessions'
import { useSettings } from '../../store/settings'
import {
  agentKindLabel,
  ensureAgent,
  injectAgentPrompt,
  setAgentUiMode
} from '../../lib/agent-ui'

/**
 * Compact "Ask agent" strip under the remote shell. Submitting ensures the
 * selected backend is running, injects the prompt into its PTY, and leaves
 * the agent UI in the current mode (or docked if it was fully stopped).
 */
export default function AgentAskBar({
  session,
  kind,
  mode,
  onKindChange,
  onModeChange,
  disabled
}: {
  session: Session
  kind: AgentKind
  mode: PolicyMode
  onKindChange: (k: AgentKind) => void
  onModeChange: (m: PolicyMode) => void
  disabled?: boolean
}) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const agentRunning = !!session.agentUiMode
  const persistAgentKind = useSettings((s) => s.setAgentKind)

  const submit = useCallback(async () => {
    const prompt = text.trim()
    if (!prompt || busy || disabled) return
    setBusy(true)
    setError(null)
    try {
      const uiMode = session.agentUiMode ?? 'docked'
      const result = await ensureAgent({
        sessionId: session.id,
        kind,
        mode,
        cwd: session.cwd,
        uiMode
      })
      // If the agent was fully stopped, surface the docked terminal so the
      // operator can watch the response. Hidden/floating keep their mode.
      if (!session.agentUiMode) {
        await setAgentUiMode(session.id, 'docked', {
          kind,
          policyMode: mode,
          title: session.context?.hostname ?? session.title
        })
      }
      await injectAgentPrompt(session.id, result.ptyId, prompt)
      setText('')
    } catch (e) {
      setError(String((e as Error).message || e))
    } finally {
      setBusy(false)
    }
  }, [text, busy, disabled, session, kind, mode])

  // Ctrl/Cmd+Enter submits from the box.
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        void submit()
      }
    }
    el.addEventListener('keydown', onKey)
    return () => el.removeEventListener('keydown', onKey)
  }, [submit])

  return (
    <div className={`agent-ask-bar${agentRunning ? ' is-live' : ''}${busy ? ' is-busy' : ''}`}>
      <div className="agent-ask-meta">
        <label className="agent-ask-field" title="Agent backend for this prompt">
          <span className="agent-ask-label">Agent</span>
          <select
            className="agent-ask-select"
            value={kind}
            disabled={agentRunning || busy || disabled}
            onChange={(e) => {
              const next = e.target.value as AgentKind
              onKindChange(next)
              persistAgentKind(next)
            }}
          >
            <optgroup label="Built in">
              <option value="devterm">DevTerm Agent</option>
            </optgroup>
            <optgroup label="External CLI">
              <option value="claude">Claude</option>
              <option value="pi">Pi</option>
              <option value="opencode">OpenCode</option>
              <option value="kimi">Kimi</option>
              <option value="grok">Grok</option>
              <option value="codex">Codex</option>
              <option value="antigravity">Antigravity</option>
            </optgroup>
          </select>
        </label>
        <label className="agent-ask-field" title="What the agent may do on this host">
          <span className="agent-ask-label">Policy</span>
          <select
            className="agent-ask-select"
            value={mode}
            disabled={agentRunning || busy || disabled}
            onChange={(e) => onModeChange(e.target.value as PolicyMode)}
          >
            <option value="read_only">Read-only</option>
            <option value="confirm">Ask first</option>
            <option value="full">Bypass</option>
          </select>
        </label>
        {session.agentUiMode && (
          <span
            className={`agent-ask-mode-chip agent-ask-mode-chip--${session.agentUiMode}`}
            title="Current agent UI placement"
          >
            {session.agentUiMode}
            {session.agentTask ? ` · ${session.agentTask}` : ''}
          </span>
        )}
        {error && (
          <span className="agent-ask-error" title={error}>
            {error}
          </span>
        )}
      </div>
      <div className="agent-ask-row">
        <textarea
          ref={inputRef}
          className="agent-ask-input"
          rows={1}
          placeholder={
            disabled
              ? 'Connect SSH to ask the agent…'
              : agentRunning
                ? `Ask ${agentKindLabel(kind)}… (Ctrl+Enter)`
                : `Ask ${agentKindLabel(kind)} — starts agent on send (Ctrl+Enter)`
          }
          value={text}
          disabled={busy || disabled}
          onChange={(e) => setText(e.target.value)}
        />
        <button
          type="button"
          className="agent-ask-send"
          disabled={busy || disabled || !text.trim()}
          onClick={() => void submit()}
          title="Send to agent (Ctrl+Enter)"
        >
          {busy ? '…' : 'Ask'}
        </button>
      </div>
    </div>
  )
}
