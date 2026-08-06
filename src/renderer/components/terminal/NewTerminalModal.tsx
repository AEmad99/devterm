/**
 * Picker shown when the user asks for a new tab (double-clicking a pane's tab bar
 * or pressing its ＋). Lets them choose a local shell, a remote SSH connection, or
 * a web browser pane — replacing the old fixed "+ Local" / "+ SSH" titlebar buttons.
 */
import { IconLocal, IconRemote, IconBrowser, IconGrid } from '../common/Icons'
import { useEscapeKey } from '../../lib/useEscapeKey'

export default function NewTerminalModal({
  onLocal,
  onRemote,
  onBrowser,
  onGrid,
  onClose
}: {
  onLocal: () => void
  onRemote: () => void
  onBrowser: () => void
  onGrid: () => void
  onClose: () => void
}) {
  useEscapeKey(onClose)

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal new-term-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-term-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id="new-term-title">New tab</h3>
        <div className="nt-list" role="menu" aria-labelledby="new-term-title">
          <button className="nt-row" role="menuitem" onClick={onLocal}>
            <span className="nt-tile">
              <IconLocal size={18} />
            </span>
            <span className="nt-text">
              <span className="nt-label">Local shell</span>
              <span className="nt-desc">A terminal on this machine</span>
            </span>
            <span className="nt-go" aria-hidden="true">
              ›
            </span>
          </button>
          <button className="nt-row" role="menuitem" onClick={onRemote}>
            <span className="nt-tile">
              <IconRemote size={18} />
            </span>
            <span className="nt-text">
              <span className="nt-label">Remote (SSH)</span>
              <span className="nt-desc">Connect to a saved server</span>
            </span>
            <span className="nt-go" aria-hidden="true">
              ›
            </span>
          </button>
          <button className="nt-row" role="menuitem" onClick={onBrowser}>
            <span className="nt-tile">
              <IconBrowser size={18} />
            </span>
            <span className="nt-text">
              <span className="nt-label">Browser</span>
              <span className="nt-desc">Open a web page in a pane</span>
            </span>
            <span className="nt-go" aria-hidden="true">
              ›
            </span>
          </button>
          <button className="nt-row" role="menuitem" onClick={onGrid}>
            <span className="nt-tile">
              <IconGrid size={18} />
            </span>
            <span className="nt-text">
              <span className="nt-label">Grid</span>
              <span className="nt-desc">Arrange multiple panes</span>
            </span>
            <span className="nt-go" aria-hidden="true">
              ›
            </span>
          </button>
        </div>
        <div className="actions">
          <span className="spacer" />
          <button className="ghost" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
