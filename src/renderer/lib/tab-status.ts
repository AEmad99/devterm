// Per-session tab status, derived from the session's underlying state (SSH
// status string, agent bridge state, pending-approval flag) into a single
// discriminated value the tab dot can style. The derivation is centralised
// here so the same logic can be unit-tested in isolation and reused by both
// the tab dot in TerminalLayout and any future place that wants a "is this
// session OK?" summary (status bar, palette, etc.).
//
// The dot itself only needs a tone; the underlying state is exposed for the
// tooltip so the user can hover the dot to see "reconnecting attempt 2/5".
//
// `tabStatus` is a pure function over a session-shaped object so the call site
// can pass a partial (e.g. just the fields it cares about) when computing
// derived UI from elsewhere.

import type { AgentBridgeState } from '@shared/types'

export type TabStatusTone =
  | 'idle'
  | 'warn'
  | 'error'
  | 'pending'
  | 'attention'
  | 'running'
  | 'unread'

export interface TabStatus {
  /** What the dot should be colored as. */
  tone: TabStatusTone
  /** Plain-text reason (e.g. "reconnecting attempt 2/5"). Used in the tooltip. */
  reason?: string
  /**
   * Optional bridge / approval substate for callers that want to know WHY.
   * Not used by the dot itself; exposed for the activity panel to filter on.
   */
  bridgeState?: AgentBridgeState
  /** True when an agent approval is outstanding for this session. */
  pendingApproval?: boolean
}

/** Inputs the derivation needs from a Session. */
export interface SessionStatusInput {
  status?: string
  closed?: boolean
  agentBridgeState?: AgentBridgeState
  agentPendingApproval?: boolean
  needsAttention?: boolean
  hasUnreadOutput?: boolean
  processRunning?: boolean
  exitCode?: number | null
}

/**
 * Reduce the session state into a single `TabStatus`. Order of precedence
 * matters: an error shadows a pending reconnect, and a pending approval
 * shadows an idle-but-OK state.
 */
export function deriveTabStatus(s: SessionStatusInput): TabStatus {
  // 1. Errors first — a hard failure (handshake failed, reconnect exhausted,
  //    host key mismatch, shell exited with a non-zero code, etc.).
  if (isErrorStatus(s.status) || (s.exitCode != null && s.exitCode !== 0)) {
    const reason =
      s.exitCode != null && s.exitCode !== 0
        ? `exited with code ${s.exitCode}`
        : (s.status ?? 'error')
    return {
      tone: 'error',
      reason,
      bridgeState: s.agentBridgeState,
      pendingApproval: s.agentPendingApproval
    }
  }
  // 2. Pending approval (yellow) — the agent is waiting on the operator, even
  //    if the underlying connection is otherwise fine. This is the most
  //    "action required" state the dot can show.
  if (s.agentPendingApproval) {
    return {
      tone: 'warn',
      reason: 'Agent awaiting approval',
      bridgeState: s.agentBridgeState,
      pendingApproval: true
    }
  }
  // 3. Needs attention (green) — an agent finished or a bell rang and the
  //    operator hasn't looked yet. Below a blocking approval but above the
  //    in-flight connection states: it's an actionable "come look" signal.
  if (s.needsAttention) {
    return { tone: 'attention', reason: 'Needs your attention', bridgeState: s.agentBridgeState }
  }
  // 4. Reconnecting / agent bridge not yet up — orange to flag "not OK but
  //    not failed, just in flight". Closed sessions stay idle so they don't
  //    keep glowing after the user has dismissed them.
  if (!s.closed && isReconnectingStatus(s.status)) {
    return { tone: 'pending', reason: s.status, bridgeState: s.agentBridgeState }
  }
  if (!s.closed && s.agentBridgeState === 'starting') {
    return { tone: 'pending', reason: 'Starting agent bridge', bridgeState: s.agentBridgeState }
  }
  if (!s.closed && s.agentBridgeState === 'error') {
    return { tone: 'error', reason: 'Agent bridge error', bridgeState: s.agentBridgeState }
  }
  // 5. Running process — a subtle pulse to show something is busy.
  if (s.processRunning) {
    return { tone: 'running', reason: 'Process running', bridgeState: s.agentBridgeState }
  }
  // 6. Unread output — quiet marker that new data arrived off-screen.
  if (s.hasUnreadOutput) {
    return { tone: 'unread', reason: 'Unread output', bridgeState: s.agentBridgeState }
  }
  return {
    tone: 'idle',
    bridgeState: s.agentBridgeState,
    pendingApproval: false
  }
}

/** True when `status` looks like a hard failure (error / failed / mismatch). */
function isErrorStatus(status?: string): boolean {
  if (!status) return false
  const s = status.toLowerCase()
  return (
    s.startsWith('error:') ||
    s.startsWith('failed:') ||
    s.includes('host key mismatch') ||
    s.includes('reconnect failed')
  )
}

/** True when `status` is the in-flight reconnect status. */
function isReconnectingStatus(status?: string): boolean {
  if (!status) return false
  return status.toLowerCase().startsWith('reconnecting')
}
