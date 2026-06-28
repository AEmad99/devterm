// Central registry of application keyboard shortcuts. Used in two places:
//  - App.tsx — a window keydown listener maps a matched id to an action.
//  - TerminalView.tsx — xterm's custom key handler returns false for any matched
//    hotkey so the keystroke is NOT sent to the shell (otherwise Ctrl+K etc. just
//    print `^K`); the same DOM event still bubbles to App's listener.
//
// `mod` means Ctrl on Windows/Linux and Cmd (meta) on macOS. Combos avoid bare
// Ctrl+<letter> (which collides with readline) by using Shift variants, except
// the command palette which is intentionally Ctrl/Cmd+K.

export type HotkeyId = | 'globalSearch'
  | 'palette'
  | 'paletteAlt'
  | 'newTerminal'
  | 'closeTerminal'
  | 'duplicateTerminal'
  | 'toggleSidebar'
  | 'find'
  | 'clearTerminal'
  | 'zoomIn'
  | 'zoomInAlt'
  | 'zoomOut'
  | 'zoomReset'
  | 'settings'
  | 'nextTerminal'
  | 'prevTerminal'
  | 'nextTab'
  | 'prevTab'
  | 'toggleFocus'
  | 'shortcuts'

export interface Hotkey {
  id: HotkeyId
  mod?: boolean
  shift?: boolean
  alt?: boolean
  /** Matched against KeyboardEvent.key (single chars compared lower-case). */
  key: string
  /** Human-readable action name (shown in the shortcuts sheet). */
  label: string
  /** Alias rows are matched but hidden from the shortcuts sheet. */
  alias?: boolean
}

export const HOTKEYS: Hotkey[] = [
  { id: 'palette', mod: true, key: 'k', label: 'Command palette (run a snippet)' },
  { id: 'paletteAlt', mod: true, shift: true, key: 'p', label: 'Command palette', alias: true },
  { id: 'newTerminal', mod: true, shift: true, key: 't', label: 'New terminal' },
  { id: 'closeTerminal', mod: true, shift: true, key: 'w', label: 'Close current terminal' },
  { id: 'duplicateTerminal', mod: true, shift: true, key: 'd', label: 'Duplicate terminal' },
  { id: 'toggleSidebar', mod: true, shift: true, key: 'e', label: 'Toggle file explorer' },
  { id: 'find', mod: true, shift: true, key: 'f', label: 'Find in terminal' },
  { id: 'clearTerminal', mod: true, shift: true, key: 'l', label: 'Clear terminal' },
  { id: 'zoomIn', mod: true, key: '=', label: 'Increase font size' },
  { id: 'zoomInAlt', mod: true, shift: true, key: '+', label: 'Increase font size', alias: true },
  { id: 'zoomOut', mod: true, key: '-', label: 'Decrease font size' },
  { id: 'zoomReset', mod: true, key: '0', label: 'Reset font size' },
  { id: 'nextTerminal', mod: true, key: 'PageDown', label: 'Next terminal' },
  { id: 'prevTerminal', mod: true, key: 'PageUp', label: 'Previous terminal' },
  // Ctrl+Tab / Ctrl+Shift+Tab cycle through tabs in the active group. Skipped
  // when a text input has focus (see App.tsx focus guard) so it doesn't
  // hijack form navigation. Devtools and other host shortcuts still get the
  // chord when focus is elsewhere.
  { id: 'nextTab', mod: true, key: 'Tab', label: 'Next tab' },
  { id: 'prevTab', mod: true, shift: true, key: 'Tab', label: 'Previous tab' },
  { id: 'toggleFocus', mod: true, shift: true, key: 'z', label: 'Focus (magnify) terminal' },
  { id: 'settings', mod: true, key: ',', label: 'Settings' },
  { id: 'globalSearch', mod: true, alt: true, key: 'f', label: 'Search across all terminals' },
  { id: 'shortcuts', mod: true, key: '/', label: 'Keyboard shortcuts' }
]

interface Keyish {
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  altKey: boolean
  key: string
}

/** Return the id of the hotkey this event matches, or null. */
export function matchHotkey(e: Keyish): HotkeyId | null {
  const mod = e.ctrlKey || e.metaKey
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key
  for (const h of HOTKEYS) {
    if (
      Boolean(h.mod) === mod &&
      Boolean(h.shift) === e.shiftKey &&
      Boolean(h.alt) === e.altKey &&
      h.key === key
    ) {
      return h.id
    }
  }
  return null
}

function prettyKey(key: string): string {
  if (key === 'PageUp') return 'PgUp'
  if (key === 'PageDown') return 'PgDn'
  return key.length === 1 ? key.toUpperCase() : key
}

/** Render a hotkey as a display string, e.g. "Ctrl+Shift+T" or "⌘⇧T". */
export function comboLabel(h: Hotkey, isMac: boolean): string {
  const parts: string[] = []
  if (h.mod) parts.push(isMac ? '⌘' : 'Ctrl')
  if (h.shift) parts.push(isMac ? '⇧' : 'Shift')
  if (h.alt) parts.push(isMac ? '⌥' : 'Alt')
  parts.push(prettyKey(h.key))
  return parts.join(isMac ? '' : '+')
}
