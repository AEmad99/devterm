import { comboLabel, resolveHotkeys } from '../../lib/hotkeys'
import { useSettings } from '../../store/settings'

/**
 * Clipboard shortcuts owned by the terminal's own key handler (TerminalView)
 * + capture-phase paste listener — they don't go through the app hotkey
 * registry because they're per-pane and must not fire when focus is outside a
 * terminal. Listed here so they're discoverable in the shortcuts sheet.
 */
const CLIPBOARD_SHORTCUTS: Array<{ label: string; mac: string; other: string }> = [
  { label: 'Copy (always)', mac: '⌘⇧C', other: 'Ctrl+Shift+C' },
  { label: 'Copy (when text selected)', mac: '⌘C', other: 'Ctrl+C' },
  { label: 'Paste', mac: '⌘V', other: 'Ctrl+V / Ctrl+Shift+V' }
]

export default function ShortcutsModal({ onClose }: { onClose: () => void }) {
  const isMac = window.devterm.platform === 'darwin'
  const keybindings = useSettings((s) => s.keybindings)
  const rows = resolveHotkeys(keybindings).filter((h) => !h.alias)

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Keyboard shortcuts</h3>
        <div className="shortcuts-list">
          {rows.map((h) => (
            <div key={h.id} className="shortcut-row">
              <span className="shortcut-label">{h.label}</span>
              <kbd>{comboLabel(h, isMac)}</kbd>
            </div>
          ))}
        </div>
        <h4 className="shortcuts-subhead">In a terminal pane</h4>
        <div className="shortcuts-list">
          {CLIPBOARD_SHORTCUTS.map((c) => (
            <div key={c.label} className="shortcut-row">
              <span className="shortcut-label">{c.label}</span>
              <kbd>{isMac ? c.mac : c.other}</kbd>
            </div>
          ))}
        </div>
        <div className="actions">
          <span className="spacer" />
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}
