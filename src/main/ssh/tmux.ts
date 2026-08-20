import type { TmuxListing, TmuxSessionInfo } from '@shared/types'
import { shQuote } from '../utils/shell-quote'

/** Format string for `tmux list-sessions -F`. Tabs keep names with spaces intact. */
export const TMUX_LIST_FORMAT =
  '#{session_name}\t#{session_windows}\t#{session_attached}\t#{session_created}\t#{session_activity}\t#{window_name}\t#{pane_current_command}\t#{pane_current_path}'

/** Compact window labels for the picker (`0:vim*`). */
export const TMUX_WIN_FORMAT = '#{window_index}:#{window_name}#{?window_active,*,}'

/**
 * One-shot probe + list + visible-pane capture. `__DT_TMUX_OK` /
 * `__DT_TMUX_MISSING` is the only signal we trust — `tmux -V` failing
 * (missing libncurses, etc.) is treated as "not available", matching the
 * detached-session bootstrap.
 *
 * Previews are dumped after `__DT_PREVIEWS` so a host with many sessions
 * still yields a usable list if a later `capture-pane` stalls.
 */
export const TMUX_PROBE_AND_LIST =
  `if command -v tmux >/dev/null 2>&1 && tmux -V >/dev/null 2>&1; then ` +
  `printf '__DT_VER=%s\\n' "$(tmux -V)"; printf '__DT_TMUX_OK\\n'; ` +
  `tmux list-sessions -F '${TMUX_LIST_FORMAT}' 2>/dev/null || true; ` +
  `printf '__DT_PREVIEWS\\n'; ` +
  `tmux list-sessions -F '#{session_name}' 2>/dev/null | while IFS= read -r __dt_n; do ` +
  `[ -n "$__dt_n" ] || continue; ` +
  `printf '__DT_P_BEGIN %s\\n' "$__dt_n"; ` +
  `printf '__DT_WINS '; ` +
  `tmux list-windows -t "$__dt_n" -F '${TMUX_WIN_FORMAT}' 2>/dev/null | awk '{printf "%s%s", p, $0; p="|"}'; ` +
  `printf '\\n'; ` +
  `tmux capture-pane -pt "$__dt_n:" -p -J -S -48 2>/dev/null || true; ` +
  `printf '\\n__DT_P_END\\n'; ` +
  `done; ` +
  `else printf '__DT_TMUX_MISSING\\n'; fi`

/** CSI / OSC / stray-ESC — same shapes as search ingest, but we keep newlines. */
const PREVIEW_ANSI_RE =
  /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\|$)|\x1b[ -/]*[0-~]/g
const PREVIEW_CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g
const PREVIEW_MAX_LINES = 48
const PREVIEW_MAX_COLS = 220

/** Plain-text pane snapshot for the picker; drops VT noise, keeps line breaks. */
export function sanitizeTmuxPreview(raw: string): string {
  const cleaned = raw
    .replace(PREVIEW_ANSI_RE, '')
    .replace(PREVIEW_CONTROL_RE, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
  const lines = cleaned.split('\n').map((line) => {
    const trimmed = line.replace(/[ \t]+$/g, '')
    return trimmed.length > PREVIEW_MAX_COLS
      ? `${trimmed.slice(0, PREVIEW_MAX_COLS - 1)}…`
      : trimmed
  })
  while (lines.length && !lines[0]) lines.shift()
  while (lines.length && !lines[lines.length - 1]) lines.pop()
  return lines.slice(-PREVIEW_MAX_LINES).join('\n')
}

/** tmux treats `.` and `:` as hierarchy separators; keep new names boring. */
export function sanitizeTmuxName(raw: string): string {
  const cleaned = raw
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return cleaned.slice(0, 48)
}

/** Stable DevTerm-owned session name used by the legacy auto-attach path. */
export function defaultTmuxName(sessionId: string): string {
  return `devterm-${sanitizeTmuxName(sessionId)}`
}

function optionalEpoch(raw: string | undefined): number | undefined {
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

function optionalText(raw: string | undefined): string | undefined {
  const t = raw?.trim()
  return t ? t : undefined
}

export function parseTmuxListSessions(stdout: string): TmuxSessionInfo[] {
  const sessions: TmuxSessionInfo[] = []
  const listing = stdout.split('__DT_PREVIEWS')[0] ?? stdout
  for (const line of listing.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (/^__DT_/.test(trimmed)) continue
    if (/no server running/i.test(trimmed)) continue
    if (/^error\b/i.test(trimmed)) continue
    const parts = trimmed.split('\t')
    const name = parts[0]
    if (!name) continue
    const session: TmuxSessionInfo = {
      name,
      windows: Number(parts[1]) || 0,
      attached: Number(parts[2]) || 0
    }
    const created = optionalEpoch(parts[3])
    const activity = optionalEpoch(parts[4])
    const currentWindow = optionalText(parts[5])
    const currentCommand = optionalText(parts[6])
    const currentPath = optionalText(parts[7])
    if (created) session.created = created
    if (activity) session.activity = activity
    if (currentWindow) session.currentWindow = currentWindow
    if (currentCommand) session.currentCommand = currentCommand
    if (currentPath) session.currentPath = currentPath
    sessions.push(session)
  }
  return sessions
}

export function applyTmuxPreviews(sessions: TmuxSessionInfo[], stdout: string): void {
  const marker = stdout.indexOf('__DT_PREVIEWS')
  if (marker < 0) return
  const byName = new Map(sessions.map((s) => [s.name, s]))
  const blocks = stdout.slice(marker).split('__DT_P_BEGIN ')
  for (const block of blocks.slice(1)) {
    const nl = block.indexOf('\n')
    if (nl < 0) continue
    const name = block.slice(0, nl).replace(/\r$/, '').trim()
    const session = byName.get(name)
    if (!session) continue
    const end = block.indexOf('__DT_P_END')
    const body = (end >= 0 ? block.slice(nl + 1, end) : block.slice(nl + 1)).replace(/\r/g, '')
    const lines = body.split('\n')
    let start = 0
    if (lines[0]?.startsWith('__DT_WINS ')) {
      const raw = lines[0].slice('__DT_WINS '.length).trim()
      if (raw)
        session.windowList = raw
          .split('|')
          .map((w) => w.trim())
          .filter(Boolean)
      start = 1
    }
    const preview = sanitizeTmuxPreview(lines.slice(start).join('\n'))
    if (preview) session.preview = preview
  }
}

export function parseTmuxListing(stdout: string, stderr = ''): TmuxListing {
  if (!/__DT_TMUX_OK/.test(stdout)) {
    return {
      available: false,
      sessions: [],
      error: stderr.trim() || undefined
    }
  }
  const verLine = stdout.split(/\r?\n/).find((l) => l.startsWith('__DT_VER='))
  const version = verLine ? verLine.slice('__DT_VER='.length).trim() : undefined
  const sessions = parseTmuxListSessions(stdout)
  applyTmuxPreviews(sessions, stdout)
  return {
    available: true,
    version,
    sessions
  }
}

/**
 * Attach the *current* login shell to a tmux session as a child process.
 *
 * Do **not** `exec` tmux: when the operator detaches (prefix+d) the tmux
 * client exits, and `exec` would take the SSH channel with it — the pane
 * then shows "[connection closed]". Running attach as a regular command
 * returns them to the login shell.
 */
export function buildTmuxAttachCommand(
  sessionName: string,
  opts: { create?: boolean } = {}
): string {
  const q = shQuote(sessionName)
  const create = opts.create
    ? `tmux has-session -t ${q} 2>/dev/null || tmux new-session -Ad -s ${q}; `
    : ''
  return (
    create +
    `tmux set-option -t ${q} allow-passthrough on 2>/dev/null; ` +
    `tmux attach-session -t ${q}; _dt_ec=$?; ` +
    `stty echo 2>/dev/null; ` +
    `if [ "$_dt_ec" -eq 0 ]; then ` +
    `printf '\\r\\n[DevTerm: detached from tmux; back in a normal shell]\\r\\n'; ` +
    `else printf '\\r\\n[DevTerm: tmux attach failed; staying in a normal shell]\\r\\n'; ` +
    `fi\n`
  )
}

/** Banner tmux prints when the client leaves a session. */
export const TMUX_CLIENT_LEFT_RE = /\[detached(?: \([^)]*\))?\]|\[exited\]/

export function buildTmuxKillCommand(sessionName: string): string {
  return `tmux kill-session -t ${shQuote(sessionName)}`
}

export const TMUX_LIST_CLIENTS_FORMAT = '#{client_tty}\t#{client_session}\t#{client_activity}'

export const TMUX_LIST_CLIENTS = `tmux list-clients -F '${TMUX_LIST_CLIENTS_FORMAT}' 2>/dev/null || true`

export interface TmuxClientInfo {
  tty: string
  session: string
  activity: number
}

export function parseTmuxClients(stdout: string): TmuxClientInfo[] {
  const out: TmuxClientInfo[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || /^__DT_/.test(trimmed) || /^error\b/i.test(trimmed)) continue
    const parts = trimmed.split('\t')
    const tty = parts[0]?.trim()
    const session = parts[1]?.trim()
    if (!tty || !session) continue
    const activity = Number(parts[2])
    out.push({
      tty,
      session,
      activity: Number.isFinite(activity) ? activity : 0
    })
  }
  return out
}

/** Prefer the most recently active client attached to `sessionName`. */
export function pickClientTty(clients: TmuxClientInfo[], sessionName: string): string | undefined {
  let best: TmuxClientInfo | undefined
  for (const c of clients) {
    if (c.session !== sessionName) continue
    if (!best || c.activity > best.activity) best = c
  }
  return best?.tty
}

export function buildTmuxSwitchCommand(tty: string, sessionName: string): string {
  return `tmux switch-client -c ${shQuote(tty)} -t ${shQuote(sessionName)}`
}

export function buildTmuxDetachClientCommand(tty: string): string {
  return `tmux detach-client -t ${shQuote(tty)}`
}

export function buildTmuxEnsureSessionCommand(sessionName: string): string {
  const q = shQuote(sessionName)
  return `tmux has-session -t ${q} 2>/dev/null || tmux new-session -Ad -s ${q}`
}

/** True when kill-session's failure is "already gone", not a real error. */
export function isTmuxSessionGone(stdout: string, stderr: string, code: number | null): boolean {
  if (code === 0) return true
  const text = `${stdout}\n${stderr}`
  return /can't find session|session not found|no server running/i.test(text)
}

/**
 * Legacy helper: create-or-reuse `devterm-<sessionId>` and attach without
 * replacing the login shell.
 */
export function buildDetachedSessionBootstrap(sessionId: string): string {
  return buildTmuxAttachCommand(defaultTmuxName(sessionId), { create: true })
}
