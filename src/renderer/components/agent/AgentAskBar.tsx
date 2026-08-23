import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentKind } from '@shared/types'
import type { Session } from '../../store/sessions'
import { useSettings } from '../../store/settings'
import {
  AGENT_BRIDGE_POLICY,
  agentKindLabel,
  ensureAgent,
  injectAgentPrompt,
  setAgentUiMode
} from '../../lib/agent-ui'

/**
 * Compact "Ask agent" strip under the remote shell. This is the launch surface:
 * submitting ensures the selected backend is running, injects the prompt into
 * its PTY, and docks the pane if the agent was fully stopped. Kind is chosen
 * here before start; placement (hide/float/stop) lives on the remote top bar
 * once the process is alive.
 */
export default function AgentAskBar({
  session,
  kind,
  onKindChange,
  disabled
}: {
  session: Session
  kind: AgentKind
  onKindChange: (k: AgentKind) => void
  disabled?: boolean
}) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const agentRunning = !!session.agentUiMode
  const persistAgentKind = useSettings((s) => s.setAgentKind)

  const startAgent = useCallback(
    async (uiMode: 'docked' | 'hidden' | 'floating', initialPrompt?: string) => {
      const result = await ensureAgent({
        sessionId: session.id,
        kind,
        mode: AGENT_BRIDGE_POLICY,
        cwd: session.cwd,
        uiMode,
        initialPrompt
      })
      if (!session.agentUiMode) {
        await setAgentUiMode(session.id, uiMode, {
          kind,
          title: session.context?.hostname ?? session.title
        })
      }
      return result
    },
    [session, kind]
  )

  const submit = useCallback(async () => {
    const prompt = text.trim()
    if (!prompt || busy || disabled) return
    setBusy(true)
    setError(null)
    try {
      const launching = !session.agentUiMode
      const seedOnLaunch = launching && (kind === 'devterm' || kind === 'pi')
      const result = await startAgent(
        session.agentUiMode ?? 'docked',
        seedOnLaunch ? prompt : undefined
      )
      // DevTerm Agent / Pi take the first message as a CLI arg. Reused
      // sessions and other CLIs still need a PTY inject + Enter.
      const seeded = seedOnLaunch && !result.reused
      if (!seeded) {
        await injectAgentPrompt(session.id, result.ptyId, prompt, { fresh: !result.reused })
      }
      setText('')
    } catch (e) {
      setError(String((e as Error).message || e))
    } finally {
      setBusy(false)
    }
  }, [text, busy, disabled, session, kind, startAgent])

  const openPane = useCallback(async () => {
    if (busy || disabled || agentRunning) return
    setBusy(true)
    setError(null)
    try {
      await startAgent('docked')
    } catch (e) {
      setError(String((e as Error).message || e))
    } finally {
      setBusy(false)
    }
  }, [busy, disabled, agentRunning, startAgent])

  // Enter sends; Shift+Enter inserts a newline. Ctrl/Cmd+Enter also sends.
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter') return
      if (e.shiftKey) return
      e.preventDefault()
      void submit()
    }
    el.addEventListener('keydown', onKey)
    return () => el.removeEventListener('keydown', onKey)
  }, [submit])

  const showMeta = !agentRunning || !!error

  return (
    <div className={`agent-ask-bar${agentRunning ? ' is-live' : ''}${busy ? ' is-busy' : ''}`}>
      {showMeta && (
        <div className="agent-ask-meta">
          {!agentRunning && (
            <label className="agent-ask-field" title="Agent backend for this prompt">
              <span className="agent-ask-label">Agent</span>
              <select
                className="agent-ask-select"
                value={kind}
                disabled={busy || disabled}
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
          )}
          {error && (
            <span className="agent-ask-error" title={error}>
              {error}
            </span>
          )}
          {!agentRunning && (
            <button
              type="button"
              className="agent-ask-open"
              disabled={busy || disabled}
              onClick={() => void openPane()}
              title="Open the agent pane without sending a prompt (for login or the agent TUI)"
            >
              {busy ? 'Starting…' : 'Open pane'}
            </button>
          )}
        </div>
      )}
      <div className="agent-ask-row">
        <textarea
          ref={inputRef}
          className="agent-ask-input"
          rows={1}
          placeholder={
            disabled
              ? 'Connect SSH to ask the agent…'
              : agentRunning
                ? `Ask ${agentKindLabel(kind)}… (Enter to send)`
                : `Ask ${agentKindLabel(kind)} — starts agent on send`
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
          title="Send to agent (Enter)"
        >
          {busy ? '…' : 'Ask'}
        </button>
      </div>
    </div>
  )
}
