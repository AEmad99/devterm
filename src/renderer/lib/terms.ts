// A tiny registry of live xterm instances keyed by session id, so non-terminal
// code (keyboard shortcuts that switch/clear/focus terminals) can reach the
// right pane. TerminalView registers on mount and unregisters on dispose.

import type { Terminal } from '@xterm/xterm'

const registry = new Map<string, Terminal>()
// Per-session input senders. Local PTYs are keyed by a backend pty id that
// differs from the session id, so callers outside TerminalView (snippets, the
// command palette) can't address pty:input themselves — they go through the
// sender TerminalView wires up for its own keystrokes.
const inputs = new Map<string, (data: string) => void>()

export function registerTerminal(id: string, term: Terminal): void {
  registry.set(id, term)
}

export function unregisterTerminal(id: string): void {
  registry.delete(id)
  inputs.delete(id)
}

export function registerTerminalInput(id: string, send: (data: string) => void): void {
  inputs.set(id, send)
}

/** Write to a session's shell exactly as if typed. False if it isn't wired yet. */
export function sendTerminalInput(id: string, data: string): boolean {
  const send = inputs.get(id)
  if (!send) return false
  send(data)
  return true
}

/** Move keyboard focus to a session's terminal, if it's mounted. */
export function focusTerminal(id: string): void {
  registry.get(id)?.focus()
}

/** Clear a session's terminal scrollback (keeps the current prompt line). */
export function clearTerminal(id: string): void {
  registry.get(id)?.clear()
}
