import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { AgentBridgeStatus, AgentKind, PolicyMode } from '@shared/types'
import { useSessions } from '../../store/sessions'
import { useSettings } from '../../store/settings'
import { fitNow, fitSoon } from '../../lib/fit'
import { attachRenderer, attachClipboard } from '../../lib/renderer'
import { createIdleChime, AGENT_ATTENTION_BODY } from '../../lib/attention'
import { useBridgeActivity } from '../../lib/bridge-activity'
import { agentKindLabel } from '../../lib/agent-ui'

/** Live state of the agent's link to this host (what the status pill reflects). */
type BridgeState = AgentBridgeStatus['state'] | 'connecting' | 'exited'

const MODE_LABEL: Record<PolicyMode, string> = {
  read_only: 'Read-only',
  confirm: 'Ask first',
  full: 'Bypass'
}

/**
 * Build a compact agent-task string for the session tab.
 * Bridge activity detail is often `key=value` dumps (e.g.
 * `command=python3 <<'PY' …`); keep the tool name plus the useful value.
 */
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

  // Generic first key=value — drop the key name noise.
  const firstKv = d.match(/^([a-zA-Z_][\w]*)=(.*)$/)
  if (firstKv) return `${tool}: ${firstKv[2]}`

  return `${tool}: ${d}`
}

/**
 * Runs the embedded DevTerm Agent or a fallback coding-agent CLI in a node-pty,
 * wired to the in-process MCP bridge for this session. The pane is a plain
 * terminal; the status pill is driven by the bridge's actual HTTP/SSE state.
 *
 * Lifecycle: open is **idempotent** unless `forceRestart` (Restart button).
 * Unmount does **not** stop the agent when `closeOnUnmount` is false — that
 * lets UI modes (docked / floating / hidden) share one process.
 */
export default function AgentPane({
  sessionId,
  kind,
  mode,
  /** When false, the PTY is display-only (stashed / non-active surface). */
  active = true,
  /**
   * When false, unmounting leaves the agent process running (mode switches).
   * Parent must call agent.close when the operator fully stops the agent.
   */
  closeOnUnmount = false,
  /** Mirror bridge/task into the main sessions store (skip in floating window). */
  mirrorToStore = true,
  /** Extra controls rendered in the status bar (mode buttons). */
  toolbar
}: {
  sessionId: string
  kind: AgentKind
  mode: PolicyMode
  active?: boolean
  closeOnUnmount?: boolean
  mirrorToStore?: boolean
  toolbar?: ReactNode
}) {
  const label = agentKindLabel(kind).replace(/ Agent$/, '')
  const hostRef = useRef<HTMLDivElement>(null)
  const activeRef = useRef(active)
  activeRef.current = active
  const [bridge, setBridge] = useState<BridgeState>('connecting')
  const [bridgeMessage, setBridgeMessage] = useState<string | undefined>()
  const [mcpUrl, setMcpUrl] = useState<string | undefined>()
  const [lastHeartbeatAt, setLastHeartbeatAt] = useState<number | undefined>()
  const [restartNonce, setRestartNonce] = useState(0)
  const hostClosed = useSessions((s) => s.sessions.find((x) => x.id === sessionId)?.closed ?? false)
  // The operator's live shell cwd (tracked from OSC 7 in TerminalView). Pushed
  // to main so the agent's commands follow the operator's `cd`. Kept out of the
  // agent-launch effect's deps so a `cd` never restarts the agent.
  const cwd = useSessions((s) => s.sessions.find((x) => x.id === sessionId)?.cwd)
  const setAgentBridgeState = useSessions((s) => s.setAgentBridgeState)
  const setAgentTask = useSessions((s) => s.setAgentTask)
  const setAgentUi = useSessions((s) => s.setAgentUi)
  const { entries } = useBridgeActivity(sessionId)

  // Surface the latest agent activity in the session tab.
  useEffect(() => {
    if (!mirrorToStore) return
    const latest = entries[entries.length - 1]
    if (!latest) return
    if (latest.kind === 'tool_call') {
      const task = formatAgentTabTask(latest.tool, latest.detail)
      setAgentTask(sessionId, task, kind)
    } else if (latest.kind === 'approval_request') {
      setAgentTask(sessionId, 'awaiting approval', kind)
    } else if (latest.kind === 'approval_outcome') {
      setAgentTask(sessionId, latest.ok ? 'approval granted' : 'approval denied', kind)
    }
  }, [entries, sessionId, kind, setAgentTask, mirrorToStore])

  useEffect(() => {
    return window.devterm.agent.onBridgeStatus(sessionId, (status) => {
      setBridge(status.state)
      setBridgeMessage(status.message)
      if (status.mcpUrl) setMcpUrl(status.mcpUrl)
      setLastHeartbeatAt(status.lastHeartbeatAt)
      if (mirrorToStore) {
        setAgentBridgeState(sessionId, status.state)
        if (status.state === 'stopped' || status.state === 'error') {
          setAgentTask(sessionId, undefined, kind)
        }
      }
    })
  }, [sessionId, kind, setAgentBridgeState, setAgentTask, mirrorToStore])

  // Mirror the live cwd to main on every change (and on mount).
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
    const forceRestart = restartNonce > 0
    term.write(
      forceRestart
        ? `\x1b[90mRestarting ${label} agent...\x1b[0m\r\n`
        : `\x1b[90mStarting ${label} agent bridged to this host...\x1b[0m\r\n`
    )

    let disposed = false
    const cleanups: Array<() => void> = [disposeRenderer, disposeClipboard]

    ;(async () => {
      try {
        const { ptyId, mcpUrl: url, reused } = await window.devterm.agent.open({
          sessionId,
          kind,
          mode,
          preferences: kind === 'devterm' ? useSettings.getState().agentPreferences : undefined,
          cwd: useSessions.getState().sessions.find((x) => x.id === sessionId)?.cwd,
          cols: term.cols,
          rows: term.rows,
          forceRestart
        })
        if (disposed) {
          // Only kill if we were asked to own the lifecycle.
          if (closeOnUnmount) window.devterm.agent.close(sessionId)
          return
        }
        if (mirrorToStore) {
          setAgentUi(sessionId, { kind, policyMode: mode, ptyId })
        }
        setMcpUrl(url)
        setBridge((cur) => (cur === 'connecting' ? (reused ? 'connected' : 'listening') : cur))
        if (reused) {
          term.write(
            `\x1b[90mReattached to running ${label} agent (MCP: ${url || '…'} | policy: ${mode}).\x1b[0m\r\n`
          )
        } else {
          const toolNote =
            kind === 'devterm'
              ? 'embedded multi-provider runtime, MCP-only host tools'
              : kind === 'claude'
                ? 'local file tools scratch-only'
                : kind === 'opencode'
                  ? 'built-in tools off, MCP devterm server'
                  : kind === 'kimi'
                    ? 'use mcp__devterm__* tools for host work'
                    : kind === 'grok'
                      ? 'built-in tools off, MCP devterm server'
                      : kind === 'codex'
                        ? 'built-in tools off, MCP devterm server'
                        : kind === 'antigravity'
                          ? 'use mcp__devterm__* tools for host work'
                          : 'built-in tools off'
          term.write(
            `\x1b[90mMCP bridge: ${url} | policy: ${mode} | agent: ${kind} (${toolNote})\x1b[0m\r\n`
          )
        }
        const attention = createIdleChime({
          sessionId,
          makeNotice: () => {
            const s = useSessions.getState().sessions.find((x) => x.id === sessionId)
            const hostName = s?.context?.hostname || s?.title || 'host'
            return { title: `${label} · ${hostName}`, body: AGENT_ATTENTION_BODY }
          }
        })
        cleanups.push(attention.dispose)
        cleanups.push(
          window.devterm.pty.onData(ptyId, (d) => {
            // Only the active surface owns attention chimes (stashed + floating
            // would otherwise double-notify).
            if (activeRef.current) attention.feed(d)
            term.write(d)
          })
        )
        cleanups.push(
          window.devterm.pty.onExit(ptyId, ({ exitCode }) => {
            setBridge('exited')
            setBridgeMessage(`${label} exited with code ${exitCode}`)
            term.write(
              '\x1b[?1049l' +
                '\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l' +
                '\x1b[?2004l' +
                '\x1b[?1004l' +
                '\x1b[0m' +
                '\x1b[?25h'
            )
            term.write(`\r\n\x1b[90m[${kind} exited with code ${exitCode}]\x1b[0m\r\n`)
          })
        )
        const inputDisposable = term.onData((d) => {
          // Only the active surface drives the PTY (avoids double input when
          // a stashed main pane coexists with a floating window).
          if (!activeRef.current) return
          attention.setArmed(true)
          attention.onInput()
          window.devterm.pty.input(ptyId, d)
        })
        cleanups.push(() => inputDisposable.dispose())
        const push = () => {
          if (!activeRef.current) return
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
          kind === 'devterm'
            ? `\x1b[90mAuthenticate with /login or a provider API-key environment variable, then retry. DevTerm does not store model credentials.\x1b[0m\r\n`
            : `\x1b[90mIs the \`${kind}\` CLI installed and on PATH? Authenticated with an API key or /login? Is the SSH session connected?\x1b[0m\r\n`
        )
      }
    })()

    return () => {
      disposed = true
      cleanups.forEach((fn) => fn())
      if (closeOnUnmount) {
        window.devterm.agent.close(sessionId)
        if (mirrorToStore) {
          setAgentBridgeState(sessionId, 'stopped')
          setAgentTask(sessionId, undefined, kind)
        }
      }
      term.dispose()
    }
    // restartNonce intentionally triggers a full relaunch with forceRestart.
    // closeOnUnmount / mirrorToStore are fixed for a given mount site.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, label, mode, restartNonce, sessionId])

  // When becoming active after stash/float, re-fit so the PTY matches the viewport.
  useEffect(() => {
    if (!active) return
    const host = hostRef.current
    if (!host) return
    // Soft fit only — resize is sent on the next ResizeObserver tick in the
    // main effect's observer while activeRef is true.
    const t = window.setTimeout(() => {
      host.dispatchEvent(new Event('resize'))
    }, 50)
    return () => window.clearTimeout(t)
  }, [active])

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
    (bridge === 'disconnected' ||
      bridge === 'stopped' ||
      bridge === 'exited' ||
      bridge === 'error')
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
    <div className={`agent-pane${active ? '' : ' is-inactive'}`}>
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
        {toolbar && <div className="agent-status-toolbar">{toolbar}</div>}
      </div>
      <div className="terminal-host agent-host" ref={hostRef} />
    </div>
  )
}
