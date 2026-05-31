// Send text to a terminal session, dispatching on its kind to the right IPC
// channel. Shared by snippets (the command palette) and — later — broadcast
// input and "insert suggested command". No new IPC is needed: this reuses the
// existing pty:input / ssh:input channels.

import { useSessions } from '../store/sessions'
import { useLayout, groupActiveSession } from '../store/layout'

/** The focused session id: the active tab of the active group's active leaf. */
export function activeSessionId(): string | null {
  const { groups, activeGroupId } = useLayout.getState()
  return groupActiveSession(groups.find((g) => g.id === activeGroupId))
}

/**
 * Write raw data to one session. Returns false (a no-op) if the session is
 * missing, closed, or a non-shell pane (browser/editor) that can't take input.
 */
export function sendToSession(id: string, data: string): boolean {
  const session = useSessions.getState().sessions.find((s) => s.id === id)
  if (!session || session.closed) return false
  if (session.kind === 'local') window.devterm.pty.input(id, data)
  else if (session.kind === 'remote') window.devterm.ssh.input(id, data)
  else return false
  return true
}

/** Write to the focused terminal. Returns false if there's no shell to send to. */
export function sendToActive(data: string): boolean {
  const id = activeSessionId()
  return id ? sendToSession(id, data) : false
}

/**
 * Send a command to the focused terminal. When `execute` is true a carriage
 * return is appended so the shell runs it; otherwise it's only typed in, leaving
 * the user to review and press Enter.
 */
export function runInActive(command: string, execute: boolean): boolean {
  return sendToActive(execute ? command + '\r' : command)
}
