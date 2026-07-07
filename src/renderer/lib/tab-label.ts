// Dynamic tab label derivation.
//
// The tab shows a primary title plus an optional context suffix that answers
// "what is this terminal doing right now?". The goal is to make it easy to
// tell apart many local shells, remote hosts, and agent panes without relying
// on manual renaming.
//
// Context precedence (highest first):
//   1. Terminal/agent status (closed, reconnecting, bridge error, ...)
//   2. Agent task from live bridge activity
//   3. Current command running in the shell
//   4. Current working directory folder
//
// A manually renamed tab keeps the user's chosen title as the primary text
// but still receives a dynamic context suffix.

import type { AgentBridgeState, AgentKind } from '@shared/types'

export interface TabLabelInput {
  id?: string
  kind?: 'local' | 'remote' | 'browser'
  title?: string
  customTitle?: boolean
  localNum?: number
  cwd?: string
  status?: string
  closed?: boolean
  currentCommand?: string
  agentTask?: string
  agentKind?: AgentKind
  agentBridgeState?: AgentBridgeState
  agentPendingApproval?: boolean
  context?: { hostname?: string; os?: string; detail?: string }
}

export interface TabLabel {
  /** Primary text in the tab. */
  title: string
  /** Optional secondary context suffix (cwd, command, agent task). */
  context?: string
  /** Full tooltip for the tab. */
  tooltip: string
}

const BRIDGE_LABELS: Record<AgentBridgeState, string> = {
  starting: 'agent starting…',
  listening: 'agent waiting…',
  connected: 'agent connected',
  disconnected: 'agent disconnected',
  stopped: 'agent stopped',
  error: 'agent bridge error'
}

function defaultBaseTitle(s: TabLabelInput): string {
  if (s.title && !s.title.startsWith('pending-')) return s.title
  if (s.kind === 'local') return `Local ${s.localNum ?? '?'}`
  if (s.kind === 'remote') return s.context?.hostname ? `remote · ${s.context.hostname}` : 'Remote'
  if (s.kind === 'browser') return 'Browser'
  return 'Terminal'
}

function folderName(cwd: string): string {
  if (!cwd) return ''
  const trimmed = cwd.replace(/[/\\]+$/, '')
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  const name = idx >= 0 ? trimmed.slice(idx + 1) : trimmed
  return name || (cwd.startsWith('/') ? '/' : cwd)
}

function bridgeStateLabel(state?: AgentBridgeState): string | undefined {
  if (!state) return undefined
  return BRIDGE_LABELS[state]
}

function agentLabel(kind?: AgentKind): string {
  if (!kind) return 'Agent'
  return kind === 'opencode' ? 'OpenCode' : kind.charAt(0).toUpperCase() + kind.slice(1)
}

function deriveContext(s: TabLabelInput): string | undefined {
  // Hard status overrides everything: closed, reconnecting, bridge errors.
  if (s.closed) return s.status || 'closed'
  if (s.status && s.status.toLowerCase().startsWith('reconnecting')) return s.status
  if (s.status && s.status.toLowerCase().startsWith('failed:')) return s.status

  // Agent activity is the most important "what is it doing" signal.
  if (s.agentPendingApproval) {
    return `${agentLabel(s.agentKind)}: awaiting approval`
  }
  if (s.agentTask) {
    return s.agentKind ? `${agentLabel(s.agentKind)}: ${s.agentTask}` : s.agentTask
  }
  if (
    s.agentBridgeState &&
    s.agentBridgeState !== 'connected' &&
    s.agentBridgeState !== 'stopped'
  ) {
    return bridgeStateLabel(s.agentBridgeState)
  }

  // Running foreground command.
  if (s.currentCommand) return s.currentCommand

  // Current directory.
  if (s.cwd) {
    const folder = folderName(s.cwd)
    if (folder) return folder
  }

  // Transient status that isn't covered above (e.g. "connecting · linux").
  if (s.status && !s.status.toLowerCase().startsWith('connected')) return s.status

  return undefined
}

function buildTooltip(s: TabLabelInput, title: string, context?: string): string {
  const parts: string[] = [title]
  if (context && context !== title) parts.push(context)
  if (s.cwd) parts.push(`cwd: ${s.cwd}`)
  if (s.status && !parts.includes(s.status)) parts.push(s.status)
  if (s.kind === 'remote' && s.context?.hostname) parts.push(`host: ${s.context.hostname}`)
  return parts.join('\n')
}

/**
 * Reduce a session-shaped object into the label and context the tab strip
 * should render. Pure function so it can be unit-tested and used in selectors.
 */
export function deriveTabLabel(s: TabLabelInput): TabLabel {
  const title = s.customTitle && s.title ? s.title : defaultBaseTitle(s)
  const context = deriveContext(s)
  return {
    title,
    context: context && context !== title ? context : undefined,
    tooltip: buildTooltip(s, title, context)
  }
}
