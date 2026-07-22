// Dynamic tab label derivation.
//
// The tab shows a primary title plus an optional context suffix that answers
// "what is this terminal doing right now?". The goal is to make it easy to
// tell apart many local shells, remote hosts, and agent panes without relying
// on manual renaming.
//
// Context is always a *short summary* — never the full multi-line command or
// tool payload. The full text still lives in the tooltip.
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

/** Soft cap for the visible context chip in the tab strip. */
const TAB_CONTEXT_MAX = 42

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
  if (kind === 'devterm') return 'DevTerm'
  if (kind === 'opencode') return 'OpenCode'
  if (kind === 'antigravity') return 'Antigravity'
  return kind.charAt(0).toUpperCase() + kind.slice(1)
}

function collapseWs(s: string): string {
  return s
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  if (max <= 1) return '…'
  return s.slice(0, max - 1).trimEnd() + '…'
}

/**
 * Short, human-readable summary of a shell command for tab chrome.
 *
 * Examples:
 *   `python3 <<'PY'\nimport re\n…`  →  `python3 <<…`
 *   `sudo nginx -t && systemctl reload nginx`  →  `sudo nginx -t && …`
 *   `npm run build`  →  `npm run build`
 */
export function summarizeCommand(cmd: string, maxLen = TAB_CONTEXT_MAX): string {
  let s = collapseWs(cmd)
  if (!s) return s

  // Bridge activity / flattenArgs noise: `command=python3 …` or `path=/x`.
  s = s.replace(/^(?:command|cmd|script)=/i, '')
  // If the whole string is still a single key=value (e.g. path=/etc/nginx.conf),
  // prefer the value for display.
  const loneKv = s.match(/^[a-zA-Z_][\w]*=(\S.*)$/)
  if (loneKv && !/\s\w[\w]*=/.test(loneKv[1])) {
    s = loneKv[1].trim()
  }

  // Heredoc / here-string bodies dominate the string and are useless in a tab.
  // Keep the program invocation and a `<<…` marker.
  const heredoc = s.match(
    /^((?:(?:sudo|doas|env)\s+)*(?:[\w.]+=\S+\s+)*)([^\s<]+(?:\s+-[^\s<]+)*)\s*<<[-]?\s*['"]?\w+['"]?/
  )
  if (heredoc) {
    const head = collapseWs(`${heredoc[1] ?? ''}${heredoc[2] ?? ''}`.trim())
    return truncate(head ? `${head} <<…` : '<<…', maxLen)
  }

  // PowerShell here-string: @' … '@ or @" … "@
  if (/@['"]/.test(s) && s.length > maxLen) {
    const head = s.slice(0, s.search(/@['"]/)).trim()
    return truncate(head ? `${head} @…` : s, maxLen)
  }

  // Long pipelines / chains: keep the first clause plus an ellipsis when
  // truncated so the tab still names the primary action.
  if (s.length > maxLen) {
    const cut = s.slice(0, maxLen - 1)
    const chain = cut.search(/\s(?:&&|\|\||;|\|)\s/)
    if (chain > 12) {
      return cut.slice(0, chain).trimEnd() + ' …'
    }
  }

  return truncate(s, maxLen)
}

/**
 * Short summary of an agent task string for the tab.
 *
 * AgentPane stores strings like `run_command: command=python3 …` or
 * `read_file: path=/etc/nginx/nginx.conf`. Prefer tool + the useful value,
 * not the raw `key=value` dump.
 */
export function summarizeAgentTask(task: string, maxLen = TAB_CONTEXT_MAX): string {
  const s = collapseWs(task)
  if (!s) return s

  // "tool: rest" — tool names are snake_case identifiers.
  const m = s.match(/^([a-z][\w]*):\s*(.*)$/i)
  if (!m) return summarizeCommand(s, maxLen)

  const tool = m[1]
  const rest = m[2]
  if (!rest) return truncate(tool, maxLen)

  // Prefer well-known arg keys emitted by flattenArgs.
  const commandEq = rest.match(/(?:^|\s)command=([\s\S]+)$/)
  if (commandEq) {
    // Drop trailing scalar keys (timeout_ms=…) that flattenArgs may append.
    const cmd = commandEq[1].replace(/\s+\w[\w]*=\S+\s*$/, '').trim()
    const budget = Math.max(12, maxLen - tool.length - 1)
    return truncate(`${tool} ${summarizeCommand(cmd, budget)}`, maxLen)
  }

  const pathEq = rest.match(/(?:^|\s)path=(\S+)/)
  if (pathEq) {
    const base = folderName(pathEq[1]) || pathEq[1]
    return truncate(`${tool} ${base}`, maxLen)
  }

  // Generic first key=value — use the value only.
  const firstKv = rest.match(/^([a-zA-Z_][\w]*)=(.*)$/)
  if (firstKv) {
    const budget = Math.max(12, maxLen - tool.length - 1)
    return truncate(`${tool} ${summarizeCommand(firstKv[2], budget)}`, maxLen)
  }

  const budget = Math.max(12, maxLen - tool.length - 1)
  return truncate(`${tool} ${summarizeCommand(rest, budget)}`, maxLen)
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
    const prefix = s.agentKind ? `${agentLabel(s.agentKind)}: ` : ''
    // Budget the task summary so "Grok: …" still fits a compact tab chip.
    const task = summarizeAgentTask(s.agentTask, Math.max(16, TAB_CONTEXT_MAX - prefix.length))
    return `${prefix}${task}`
  }
  if (
    s.agentBridgeState &&
    s.agentBridgeState !== 'connected' &&
    s.agentBridgeState !== 'stopped'
  ) {
    return bridgeStateLabel(s.agentBridgeState)
  }

  // Running foreground command — summarized, never the full heredoc body.
  if (s.currentCommand) return summarizeCommand(s.currentCommand)

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
  // Prefer the full raw task/command in the tooltip when present so the
  // operator can still inspect the long form that the tab summarized away.
  if (s.agentTask) {
    const full = s.agentKind
      ? `${agentLabel(s.agentKind)}: ${collapseWs(s.agentTask)}`
      : collapseWs(s.agentTask)
    parts.push(full)
  } else if (s.currentCommand) {
    parts.push(collapseWs(s.currentCommand))
  } else if (context && context !== title) {
    parts.push(context)
  }
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
