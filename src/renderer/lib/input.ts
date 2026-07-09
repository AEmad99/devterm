// Send text to a terminal session, dispatching on its kind to the right IPC
// channel. Shared by snippets (the command palette) and — later — broadcast
// input and "insert suggested command". No new IPC is needed: this reuses the
// existing pty:input / ssh:input channels.

import { useSessions, type Session } from '../store/sessions'
import { useLayout, groupActiveSession } from '../store/layout'
import { focusTerminal, sendTerminalInput } from './terms'

/** The focused session id: the active tab of the active group's active leaf. */
export function activeSessionId(): string | null {
  const { groups, activeGroupId } = useLayout.getState()
  return groupActiveSession(groups.find((g) => g.id === activeGroupId))
}

/** The focused session object (for its kind/context), or null if none. */
export function activeSession(): Session | null {
  const id = activeSessionId()
  if (!id) return null
  return useSessions.getState().sessions.find((s) => s.id === id) ?? null
}

/**
 * Write raw data to one session. Returns false (a no-op) if the session is
 * missing, closed, or a non-shell pane (browser/editor) that can't take input.
 * Goes through the sender TerminalView registers per session: local PTYs are
 * keyed by a backend pty id the session id can't address directly.
 */
export function sendToSession(id: string, data: string): boolean {
  const session = useSessions.getState().sessions.find((s) => s.id === id)
  if (!session || session.closed) return false
  if (session.kind !== 'local' && session.kind !== 'remote') return false
  if (sendTerminalInput(id, data)) return true
  // Remote shells are keyed by session id, so they can be reached even if the
  // terminal's sender isn't wired yet (e.g. while the shell channel opens).
  if (session.kind === 'remote') {
    window.devterm.ssh.input(id, data)
    return true
  }
  return false
}

/** Write to the focused terminal. Returns false if there's no shell to send to. */
export function sendToActive(data: string): boolean {
  const id = activeSessionId()
  return id ? sendToSession(id, data) : false
}

/**
 * Send a command to the focused terminal. When `execute` is true a carriage
 * return is appended so the shell runs it; otherwise it's only typed in, leaving
 * the user to review and press Enter. Executed commands are recorded to history
 * (scoped to the session's kind) so the palette can offer them as recent/most-used.
 */
export function runInActive(command: string, execute: boolean): boolean {
  const session = activeSession()
  if (!session || session.closed) return false
  if (!sendToSession(session.id, execute ? command + '\r' : command)) return false
  if (execute)
    void window.devterm.history.record(command, session.kind === 'remote' ? 'remote' : 'local')
  // Refocus the terminal after the palette/snippet UI unmounts — when the modal
  // holding focus is removed, focus falls to <body> and the user would have to
  // click the terminal before typing. Deferred so it runs after that unmount.
  setTimeout(() => focusTerminal(session.id), 0)
  return true
}

/**
 * Broadcast a command to multiple sessions. Returns which ids were reached and
 * which were not (e.g. local terminals whose TerminalView has not mounted yet).
 * History is recorded once per kind for executed commands.
 */
export function broadcastToSessions(
  ids: string[],
  command: string,
  execute: boolean
): { sent: string[]; failed: string[] } {
  const data = execute ? command + '\r' : command
  const sent: string[] = []
  const failed: string[] = []
  const kinds = new Set<'local' | 'remote'>()
  for (const id of ids) {
    const session = useSessions.getState().sessions.find((s) => s.id === id)
    if (!session || session.closed || (session.kind !== 'local' && session.kind !== 'remote')) {
      failed.push(id)
      continue
    }
    if (sendToSession(id, data)) {
      sent.push(id)
      if (execute) kinds.add(session.kind)
    } else {
      failed.push(id)
    }
  }
  if (execute && command.trim()) {
    if (kinds.has('local')) void window.devterm.history.record(command, 'local')
    if (kinds.has('remote')) void window.devterm.history.record(command, 'remote')
  }
  return { sent, failed }
}
