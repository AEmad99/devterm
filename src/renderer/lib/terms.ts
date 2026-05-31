// A tiny registry of live xterm instances keyed by session id, so non-terminal
// code (keyboard shortcuts that switch/clear/focus terminals) can reach the
// right pane. TerminalView registers on mount and unregisters on dispose.

import type { Terminal } from '@xterm/xterm'

const registry = new Map<string, Terminal>()

export function registerTerminal(id: string, term: Terminal): void {
  registry.set(id, term)
}

export function unregisterTerminal(id: string): void {
  registry.delete(id)
}

/** Move keyboard focus to a session's terminal, if it's mounted. */
export function focusTerminal(id: string): void {
  registry.get(id)?.focus()
}

/** Clear a session's terminal scrollback (keeps the current prompt line). */
export function clearTerminal(id: string): void {
  registry.get(id)?.clear()
}
