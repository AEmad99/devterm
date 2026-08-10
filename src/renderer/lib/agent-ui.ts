import type { AgentKind, AgentOpenResult, AgentUiMode, PolicyMode } from '@shared/types'
import { useSessions } from '../store/sessions'
import { useSettings } from '../store/settings'

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * Ensure the agent process is running for `sessionId` (idempotent open).
 * Updates session store with pty id / kind / policy. Does not change UI mode
 * unless `uiMode` is provided.
 */
export async function ensureAgent(opts: {
  sessionId: string
  kind: AgentKind
  mode: PolicyMode
  cols?: number
  rows?: number
  cwd?: string
  forceRestart?: boolean
  uiMode?: AgentUiMode
}): Promise<AgentOpenResult> {
  const preferences =
    opts.kind === 'devterm' ? useSettings.getState().agentPreferences : undefined
  const result = await window.devterm.agent.open({
    sessionId: opts.sessionId,
    kind: opts.kind,
    mode: opts.mode,
    preferences,
    cwd: opts.cwd,
    cols: opts.cols ?? 100,
    rows: opts.rows ?? 30,
    forceRestart: opts.forceRestart
  })
  useSessions.getState().setAgentUi(opts.sessionId, {
    mode: opts.uiMode,
    kind: opts.kind,
    policyMode: opts.mode,
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
 * "connected" is ideal; "listening" means the bridge is up and the CLI is still starting.
 */
export async function waitForAgentBridge(
  sessionId: string,
  timeoutMs = 20000
): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const st = await window.devterm.agent.status(sessionId)
    const state = st?.bridge.state
    if (state === 'connected' || state === 'listening') return true
    if (state === 'error' || state === 'stopped') return false
    await sleep(250)
  }
  return false
}

/**
 * Type a prompt into the live agent PTY and submit with Enter.
 * Best-effort: interactive TUIs may need focus; we send after a short settle delay.
 */
export async function injectAgentPrompt(
  sessionId: string,
  ptyId: string,
  text: string
): Promise<void> {
  const trimmed = text.replace(/\s+$/u, '')
  if (!trimmed) return
  // Give freshly launched TUIs a moment to draw their input line.
  await waitForAgentBridge(sessionId, 15000)
  await sleep(600)
  window.devterm.pty.input(ptyId, `${trimmed}\r`)
}

export async function setAgentUiMode(
  sessionId: string,
  mode: AgentUiMode,
  meta?: { kind?: AgentKind; policyMode?: PolicyMode; title?: string }
): Promise<void> {
  const s = useSessions.getState().sessions.find((x) => x.id === sessionId)
  const kind = meta?.kind ?? s?.agentKind ?? useSettings.getState().agentKind
  const policyMode = meta?.policyMode ?? s?.agentPolicyMode ?? 'full'

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
