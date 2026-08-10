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
// Per-session find-bar openers. App's global Ctrl/Cmd+Shift+F must work even
// when focus is on chrome/explorer — not only when xterm's custom key handler
// is the event target.
const findOpeners = new Map<string, () => void>()

export function registerTerminal(id: string, term: Terminal): void {
  registry.set(id, term)
}

export function unregisterTerminal(id: string): void {
  registry.delete(id)
  inputs.delete(id)
  // Find openers are owned by a separate TerminalView effect (find bar can
  // outlive a temporary xterm dispose/recreate); do not clear them here.
}

export function registerTerminalInput(id: string, send: (data: string) => void): void {
  inputs.set(id, send)
}

/** Register a callback that opens (or re-focuses) the per-pane find bar. */
export function registerFindOpener(id: string, open: () => void): void {
  findOpeners.set(id, open)
}

export function unregisterFindOpener(id: string): void {
  findOpeners.delete(id)
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

/**
 * Open the find bar on a mounted terminal session. Returns false when no
 * opener is registered (browser panes, pending sessions, unmounted).
 */
export function openTerminalFind(id: string): boolean {
  const open = findOpeners.get(id)
  if (!open) return false
  open()
  return true
}
