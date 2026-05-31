import { HOTKEYS, comboLabel } from '../lib/hotkeys'

export default function ShortcutsModal({ onClose }: { onClose: () => void }) {
  const isMac = window.devterm.platform === 'darwin'
  const rows = HOTKEYS.filter((h) => !h.alias)

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
        <div className="actions">
          <span className="spacer" />
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}
