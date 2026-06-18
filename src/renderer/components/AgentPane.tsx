import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { AgentBridgeStatus, AgentKind, PolicyMode } from '@shared/types'
import { useSessions } from '../store/sessions'
import { fitNow, fitSoon } from '../lib/fit'
import { attachRenderer, attachClipboard } from '../lib/renderer'
import { createIdleChime } from '../lib/attention'

/** Live state of the agent's link to this host (what the status pill reflects). */
type BridgeState = AgentBridgeStatus['state'] | 'connecting' | 'exited'

const MODE_LABEL: Record<PolicyMode, string> = {
  read_only: 'Read-only',
  confirm: 'Ask first',
  full: 'Bypass'
}

/**
 * Runs a real interactive coding-agent CLI (`claude` or `pi`, per `kind`) in a
 * node-pty, wired to the in-process MCP bridge for this session — Claude via its
 * native `--mcp-config`, pi via a loaded extension. The pane is a plain
 * terminal; the status pill is driven by the bridge's actual HTTP/SSE
 * connection state.
 */
export default function AgentPane({
  sessionId,
  kind,
  mode
}: {
  sessionId: string
  kind: AgentKind
  mode: PolicyMode
}) {
  const label = kind === 'claude' ? 'Claude' : 'Pi'
  const hostRef = useRef<HTMLDivElement>(null)
  const [bridge, setBridge] = useState<BridgeState>('connecting')
  const [bridgeMessage, setBridgeMessage] = useState<string | undefined>()
  const [mcpUrl, setMcpUrl] = useState<string | undefined>()
  const [lastHeartbeatAt, setLastHeartbeatAt] = useState<number | undefined>()
  const [restartNonce, setRestartNonce] = useState(0)
  const hostClosed = useSessions((s) => s.sessions.find((x) => x.id === sessionId)?.closed ?? false)
  // The operator's live shell cwd (tracked from OSC 7 in TerminalView). Pushed
  // to main so the agent's commands follow the operator's `cd` — see the effect
  // below. Kept out of the agent-launch effect's deps so a `cd` never restarts
  // the agent; it's a live update, not a relaunch.
  const cwd = useSessions((s) => s.sessions.find((x) => x.id === sessionId)?.cwd)
  // Mirror the bridge state up to the session store so the tab dot can color
  // on it. The local `bridge` is the source of truth for the in-pane status
  // pill; the store copy is just a cache for the chrome. We only push the
  // canonical AgentBridgeState values ('connecting' and 'exited' are
  // AgentPane-local only).
  const setAgentBridgeState = useSessions((s) => s.setAgentBridgeState)

  useEffect(() => {
    return window.devterm.agent.onBridgeStatus(sessionId, (status) => {
      setBridge(status.state)
      setBridgeMessage(status.message)
      if (status.mcpUrl) setMcpUrl(status.mcpUrl)
      setLastHeartbeatAt(status.lastHeartbeatAt)
      setAgentBridgeState(sessionId, status.state)
    })
  }, [sessionId, setAgentBridgeState])

  // Mirror the live cwd to main on every change (and on mount). open() also
  // seeds the launch cwd; this keeps it current as the operator navigates.
  // Fire-and-forget and idempotent — a push before the agent is open just
  // records the latest value for when it starts.
  useEffect(() => {
    if (cwd) window.devterm.agent.setCwd(sessionId, cwd)
  }, [sessionId, cwd])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    setBridge('connecting')
    setBridgeMessage(undefined)
    setMcpUrl(undefined)
    setLastHeartbeatAt(undefined)

    const term = new Terminal({
      fontFamily: 'Cascadia Code, Consolas, "Courier New", monospace',
      fontSize: 13,
      cursorBlink: true,
      allowProposedApi: true,
      theme: { background: '#16181d', foreground: '#d7dae0', cursor: '#7c5cff' }
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    const disposeRenderer = attachRenderer(term)
    const disposeClipboard = attachClipboard(term, host)
    fitNow(fit, host)
    term.write(`\x1b[90mStarting ${label} agent bridged to this host...\x1b[0m\r\n`)

    let disposed = false
    const cleanups: Array<() => void> = [disposeRenderer, disposeClipboard]

    ;(async () => {
      try {
        const { ptyId, mcpUrl } = await window.devterm.agent.open({
          sessionId,
          kind,
          mode,
          // Read non-reactively so the launch isn't tied to cwd changes; live
          // updates after this flow through agent.setCwd (effect above).
          cwd: useSessions.getState().sessions.find((x) => x.id === sessionId)?.cwd,
          cols: term.cols,
          rows: term.rows
        })
        if (disposed) return window.devterm.agent.close(sessionId)
        setMcpUrl(mcpUrl)
        setBridge((cur) => (cur === 'connecting' ? 'listening' : cur))
        const toolNote = kind === 'claude' ? 'local file tools scratch-only' : 'built-in tools off'
        term.write(
          `\x1b[90mMCP bridge: ${mcpUrl} | policy: ${mode} | agent: ${kind} (${toolNote})\x1b[0m\r\n`
        )
        // Raise an attention signal when this agent finishes or waits for input:
        // its output goes quiet for a beat after a real burst of work. setArmed
        // on the operator's first keystroke arms the idle path (so the startup
        // banner never chimes) and it stays armed for the session.
        const attention = createIdleChime({
          sessionId,
          minBurstMs: 2000,
          makeNotice: () => {
            const s = useSessions.getState().sessions.find((x) => x.id === sessionId)
            const host = s?.context?.hostname || s?.title || 'host'
            return { title: `${label} · ${host}`, body: 'Agent finished or needs your input' }
          }
        })
        cleanups.push(attention.dispose)
        cleanups.push(
          window.devterm.pty.onData(ptyId, (d) => {
            attention.feed(d)
            term.write(d)
          })
        )
        cleanups.push(
          window.devterm.pty.onExit(ptyId, ({ exitCode }) => {
            setBridge('exited')
            setBridgeMessage(`${label} exited with code ${exitCode}`)
            term.write(`\r\n\x1b[90m[${kind} exited with code ${exitCode}]\x1b[0m\r\n`)
          })
        )
        term.onData((d) => {
          attention.setArmed(true)
          attention.onInput()
          window.devterm.pty.input(ptyId, d)
        })
        const push = () => {
          if (fitNow(fit, host)) window.devterm.pty.resize(ptyId, term.cols, term.rows)
        }
        const ro = new ResizeObserver(push)
        ro.observe(host)
        const onWin = () => push()
        window.addEventListener('resize', onWin)
        cleanups.push(() => {
          ro.disconnect()
          window.removeEventListener('resize', onWin)
        })
        fitSoon(fit, host, push)
      } catch (e) {
        const msg = String((e as Error).message || e)
        setBridge('error')
        setBridgeMessage(msg)
        term.write(`\r\n\x1b[31m[failed to start ${kind}: ${msg}]\x1b[0m\r\n`)
        term.write(
          `\x1b[90mIs the \`${kind}\` CLI installed and on PATH? Authenticated with an API key or /login? Is the SSH session connected?\x1b[0m\r\n`
        )
      }
    })()

    return () => {
      disposed = true
      cleanups.forEach((fn) => fn())
      window.devterm.agent.close(sessionId)
      term.dispose()
      // Tab dot shouldn't keep showing the old bridge state once the pane is
      // gone. A follow-up mount of the same pane will push a fresh state on
      // its first bridge-status event.
      setAgentBridgeState(sessionId, 'stopped')
    }
  }, [kind, label, mode, restartNonce, sessionId, setAgentBridgeState])

  const pill = hostClosed
    ? { tone: 'down', text: 'Host disconnected' }
    : bridge === 'connecting'
      ? { tone: 'busy', text: 'Connecting...' }
      : bridge === 'starting' || bridge === 'listening'
        ? { tone: 'busy', text: bridge === 'starting' ? 'Starting bridge' : 'Waiting for agent' }
        : bridge === 'connected'
          ? { tone: 'ok', text: 'Bridge connected' }
          : bridge === 'disconnected'
            ? { tone: 'down', text: 'Bridge disconnected' }
            : bridge === 'stopped'
              ? { tone: 'idle', text: 'Bridge stopped' }
              : bridge === 'exited'
                ? { tone: 'idle', text: 'Agent exited' }
                : { tone: 'down', text: 'Failed to start' }
  const canRestart =
    !hostClosed &&
    (bridge === 'disconnected' || bridge === 'stopped' || bridge === 'exited' || bridge === 'error')
  const statusTitle = [
    bridgeMessage,
    mcpUrl,
    lastHeartbeatAt
      ? `Last heartbeat: ${new Date(lastHeartbeatAt).toLocaleTimeString()}`
      : undefined
  ]
    .filter(Boolean)
    .join('\n')

  return (
    <div className="agent-pane">
      <div
        className={`agent-status agent-status--${pill.tone}`}
        title={statusTitle || 'Live state of the agent bridge to this host'}
      >
        <span className="agent-dot" />
        <span className="agent-status-text">{pill.text}</span>
        {canRestart && (
          <button
            className="agent-restart"
            title="Restart the agent and reconnect the MCP bridge"
            onClick={() => setRestartNonce((n) => n + 1)}
          >
            Restart
          </button>
        )}
        <span className="agent-mode" title="What the agent is allowed to do on this host">
          {MODE_LABEL[mode]}
        </span>
      </div>
      <div className="terminal-host agent-host" ref={hostRef} />
    </div>
  )
}
