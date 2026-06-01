import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { PolicyMode } from '@shared/types'
import { useSessions } from '../store/sessions'
import { fitNow, fitSoon } from '../lib/fit'
import { attachRenderer, attachClipboard } from '../lib/renderer'

/** Live state of the agent's link to this host (what the status pill reflects). */
type BridgeState = 'connecting' | 'ready' | 'exited' | 'error'

const MODE_LABEL: Record<PolicyMode, string> = {
  read_only: 'Read-only',
  confirm: 'Ask first',
  full: 'Full access'
}

/**
 * Runs the REAL interactive `claude` CLI in a node-pty, wired to the in-process
 * MCP bridge for this session (NEVER `-p`/SDK). The pane is a plain terminal —
 * we never parse or drive its output (Trap §8) — topped by a status pill that
 * shows the genuine bridge/host state. The agent sometimes *claims* the
 * connection dropped (a confabulation — the in-process bridge can't silently
 * disconnect); the pill is the ground truth that contradicts it.
 */
export default function ClaudePane({ sessionId, mode }: { sessionId: string; mode: PolicyMode }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [bridge, setBridge] = useState<BridgeState>('connecting')
  // The only "connection" that can actually drop is the underlying SSH session;
  // surface it so the operator sees the host is up even when the agent says not.
  const hostClosed = useSessions((s) => s.sessions.find((x) => x.id === sessionId)?.closed ?? false)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    setBridge('connecting')

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
    term.write('\x1b[90mStarting Claude agent bridged to this host…\x1b[0m\r\n')

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
        setBridge('ready')
        term.write(`\x1b[90mMCP bridge: ${mcpUrl} · policy: ${mode}\x1b[0m\r\n`)
        cleanups.push(window.devterm.pty.onData(ptyId, (d) => term.write(d)))
        cleanups.push(
          window.devterm.pty.onExit(ptyId, ({ exitCode }) => {
            setBridge('exited')
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
        setBridge('error')
        term.write(
          `\r\n\x1b[31m[failed to start claude: ${String((e as Error).message || e)}]\x1b[0m\r\n`
        )
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  // A dropped SSH host overrides the bridge state — claude keeps running locally,
  // but its tools can no longer reach the host, so that's the real story to show.
  const pill = hostClosed
    ? { tone: 'down', text: 'Host disconnected' }
    : bridge === 'connecting'
      ? { tone: 'busy', text: 'Connecting…' }
      : bridge === 'ready'
        ? { tone: 'ok', text: 'Bridge ready' }
        : bridge === 'exited'
          ? { tone: 'idle', text: 'Agent exited' }
          : { tone: 'down', text: 'Failed to start' }

  return (
    <div className="claude-pane">
      <div
        className={`agent-status agent-status--${pill.tone}`}
        title="Live state of the agent's bridge to this host"
      >
        <span className="agent-dot" />
        <span className="agent-status-text">{pill.text}</span>
        <span className="agent-mode" title="What the agent is allowed to do on this host">
          {MODE_LABEL[mode]}
        </span>
      </div>
      <div className="terminal-host claude-host" ref={hostRef} />
    </div>
  )
}
