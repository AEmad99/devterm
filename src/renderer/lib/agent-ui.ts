import type { AgentKind, AgentOpenResult, AgentUiMode, PolicyMode } from '@shared/types'
import { useSessions } from '../store/sessions'
import { useSettings } from '../store/settings'

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * MCP bridge policy. Session UI no longer picks read_only/confirm/full —
 * those did not map onto Claude/Grok/Codex permission flags. The agent CLI
 * owns prompts; DevTerm Settings approval rules remain a hard MCP pre-check.
 */
export const AGENT_BRIDGE_POLICY: PolicyMode = 'full'

/**
 * Ensure the agent process is running for `sessionId` (idempotent open).
 * Updates session store with pty id / kind. Does not change UI mode
 * unless `uiMode` is provided.
 */
export async function ensureAgent(opts: {
  sessionId: string
  kind: AgentKind
  mode?: PolicyMode
  cols?: number
  rows?: number
  cwd?: string
  forceRestart?: boolean
  uiMode?: AgentUiMode
  initialPrompt?: string
  /**
   * Which surface the agent is bound to. Derived from the session store when
   * omitted, so callers (ask bar / pane) never need to care.
   */
  sessionKind?: 'local' | 'remote'
}): Promise<AgentOpenResult> {
  const preferences = opts.kind === 'devterm' ? useSettings.getState().agentPreferences : undefined
  const mode = opts.mode ?? AGENT_BRIDGE_POLICY
  const session =
    useSessions.getState().sessions.find((x) => x.id === opts.sessionId) ?? undefined
  const sessionKind = opts.sessionKind ?? (session?.kind === 'local' ? 'local' : 'remote')
  const result = await window.devterm.agent.open({
    sessionId: opts.sessionId,
    kind: opts.kind,
    mode,
    preferences,
    cwd: opts.cwd,
    cols: opts.cols ?? 100,
    rows: opts.rows ?? 30,
    forceRestart: opts.forceRestart,
    initialPrompt: opts.initialPrompt,
    sessionKind,
    browserTools: useSettings.getState().agentPreferences.browserTools !== false
  })
  useSessions.getState().setAgentUi(opts.sessionId, {
    mode: opts.uiMode,
    kind: opts.kind,
    policyMode: mode,
    ptyId: result.ptyId
  })
  return result
}

/** Stop the agent process and clear UI placement. */
export function stopAgent(sessionId: string): void {
  window.devterm.agent.close(sessionId)
  window.devterm.agent.closeWindow(sessionId)
  useSessions.getState().setAgentUi(sessionId, { mode: null })
}

/**
 * Wait until the MCP bridge looks ready enough to accept work, or until timeout.
 * "connected" means the agent CLI has completed the MCP handshake (TUI is up).
 * "listening" is only the HTTP server — the CLI may still be drawing its banner.
 */
export async function waitForAgentBridge(
  sessionId: string,
  timeoutMs = 20000,
  opts?: { requireConnected?: boolean }
): Promise<boolean> {
  const start = Date.now()
  const requireConnected = opts?.requireConnected === true
  while (Date.now() - start < timeoutMs) {
    const st = await window.devterm.agent.status(sessionId)
    const state = st?.bridge.state
    if (state === 'connected') return true
    if (!requireConnected && state === 'listening') return true
    if (state === 'error' || state === 'stopped') return false
    await sleep(250)
  }
  return false
}

/**
 * Resolve once the PTY has gone quiet. A brand-new spawn has a silent gap
 * before the TUI prints anything — that must not count as "ready".
 */
function waitForPtyQuiet(
  ptyId: string,
  opts?: { quietMs?: number; timeoutMs?: number; requireData?: boolean }
): Promise<void> {
  const quietMs = opts?.quietMs ?? 500
  const timeoutMs = opts?.timeoutMs ?? 20000
  const requireData = opts?.requireData === true
  return new Promise((resolve) => {
    let last = Date.now()
    let seenData = !requireData
    let settled = false
    let quietTimer: ReturnType<typeof setTimeout> | undefined
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(quietTimer)
      clearTimeout(limit)
      unsub()
      resolve()
    }
    const scheduleQuiet = () => {
      clearTimeout(quietTimer)
      quietTimer = setTimeout(() => {
        if (seenData && Date.now() - last >= quietMs) finish()
      }, quietMs)
    }
    const bump = () => {
      seenData = true
      last = Date.now()
      scheduleQuiet()
    }
    const unsub = window.devterm.pty.onData(ptyId, bump)
    if (!requireData) scheduleQuiet()
    const limit = setTimeout(finish, timeoutMs)
  })
}

/**
 * Type a prompt into a *running* agent PTY and submit it.
 * Text and Enter are separate writes so the TUI does not treat the burst as a paste.
 * First-launch DevTerm Agent / Pi should pass `initialPrompt` to `ensureAgent` instead.
 */
export async function injectAgentPrompt(
  sessionId: string,
  ptyId: string,
  text: string,
  opts?: { fresh?: boolean }
): Promise<void> {
  const trimmed = text.replace(/\s+$/u, '')
  if (!trimmed) return
  const ready = await waitForAgentBridge(sessionId, 20000)
  if (!ready) {
    throw new Error('Agent is not ready yet. Wait until the pane shows a prompt, then Ask again.')
  }
  if (opts?.fresh) await sleep(400)
  await waitForPtyQuiet(ptyId, { requireData: !!opts?.fresh, quietMs: opts?.fresh ? 600 : 280 })
  await sleep(80)
  window.devterm.pty.input(ptyId, trimmed)
  await sleep(80)
  window.devterm.pty.input(ptyId, '\r')
}

export async function setAgentUiMode(
  sessionId: string,
  mode: AgentUiMode,
  meta?: { kind?: AgentKind; title?: string }
): Promise<void> {
  const s = useSessions.getState().sessions.find((x) => x.id === sessionId)
  const kind = meta?.kind ?? s?.agentKind ?? useSettings.getState().agentKind
  const policyMode = AGENT_BRIDGE_POLICY

  if (mode === 'floating') {
    // setAgentUi reports mode to main; openWindow focuses/creates the OS window.
    useSessions.getState().setAgentUi(sessionId, { mode, kind, policyMode })
    await window.devterm.agent.openWindow({
      sessionId,
      kind,
      mode: policyMode,
      title: meta?.title ?? s?.context?.hostname ?? s?.title
    })
    return
  }

  // Docked / hidden: setAgentUi → setUiMode closes any float window without
  // treating it as a user X-close (no agent:window:closed demotion to hidden).
  useSessions.getState().setAgentUi(sessionId, { mode, kind, policyMode })
}

export function agentKindLabel(kind: AgentKind): string {
  switch (kind) {
    case 'devterm':
      return 'DevTerm Agent'
    case 'claude':
      return 'Claude'
    case 'opencode':
      return 'OpenCode'
    case 'kimi':
      return 'Kimi'
    case 'grok':
      return 'Grok'
    case 'codex':
      return 'Codex'
    case 'antigravity':
      return 'Antigravity'
    default:
      return 'Pi'
  }
}
