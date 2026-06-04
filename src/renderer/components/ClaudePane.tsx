import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { ClaudeBridgeStatus, PolicyMode } from '@shared/types'
import { useSessions } from '../store/sessions'
import { fitNow, fitSoon } from '../lib/fit'
import { attachRenderer, attachClipboard } from '../lib/renderer'

/** Live state of the agent's link to this host (what the status pill reflects). */
type BridgeState = ClaudeBridgeStatus['state'] | 'connecting' | 'exited'

const MODE_LABEL: Record<PolicyMode, string> = {
  read_only: 'Read-only',
  confirm: 'Ask first',
  full: 'Bypass'
}

/**
 * Runs the real interactive `claude` CLI in a node-pty, wired to the in-process
 * MCP bridge for this session. The pane is a plain terminal; the status pill is
 * driven by the bridge's actual HTTP/SSE connection state.
 */
export default function ClaudePane({ sessionId, mode }: { sessionId: string; mode: PolicyMode }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [bridge, setBridge] = useState<BridgeState>('connecting')
  const [bridgeMessage, setBridgeMessage] = useState<string | undefined>()
  const [mcpUrl, setMcpUrl] = useState<string | undefined>()
  const [lastHeartbeatAt, setLastHeartbeatAt] = useState<number | undefined>()
  const [restartNonce, setRestartNonce] = useState(0)
  const hostClosed = useSessions((s) => s.sessions.find((x) => x.id === sessionId)?.closed ?? false)

  useEffect(() => {
    return window.devterm.claude.onBridgeStatus(sessionId, (status) => {
      setBridge(status.state)
      setBridgeMessage(status.message)
      if (status.mcpUrl) setMcpUrl(status.mcpUrl)
      setLastHeartbeatAt(status.lastHeartbeatAt)
    })
  }, [sessionId])

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
    term.write('\x1b[90mStarting Claude agent bridged to this host...\x1b[0m\r\n')

    let disposed = false
    const cleanups: Array<() => void> = [disposeRenderer, disposeClipboard]

    ;(async () => {
      try {
        const { ptyId, mcpUrl } = await window.devterm.claude.open({
          sessionId,
          mode,
          cols: term.cols,
          rows: term.rows
        })
        if (disposed) return window.devterm.claude.close(sessionId)
        setMcpUrl(mcpUrl)
        setBridge((cur) => (cur === 'connecting' ? 'listening' : cur))
        term.write(
          `\x1b[90mMCP bridge: ${mcpUrl} | policy: ${mode} | permissions: bypass\x1b[0m\r\n`
        )
        cleanups.push(window.devterm.pty.onData(ptyId, (d) => term.write(d)))
        cleanups.push(
          window.devterm.pty.onExit(ptyId, ({ exitCode }) => {
            setBridge('exited')
            setBridgeMessage(`Claude exited with code ${exitCode}`)
            term.write(`\r\n\x1b[90m[claude exited with code ${exitCode}]\x1b[0m\r\n`)
          })
        )
        term.onData((d) => window.devterm.pty.input(ptyId, d))
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
        term.write(`\r\n\x1b[31m[failed to start claude: ${msg}]\x1b[0m\r\n`)
        term.write(
          '\x1b[90mIs the `claude` CLI installed and on PATH? Is the SSH session connected?\x1b[0m\r\n'
        )
      }
    })()

    return () => {
      disposed = true
      cleanups.forEach((fn) => fn())
      window.devterm.claude.close(sessionId)
      term.dispose()
    }
  }, [mode, restartNonce, sessionId])

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
    <div className="claude-pane">
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
      <div className="terminal-host claude-host" ref={hostRef} />
    </div>
  )
}
