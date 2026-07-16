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
        <div className="nt-choices">
          <button className="nt-choice" onClick={onLocal}>
            <span className="nt-ico">
              <IconLocal size={28} />
            </span>
            <span className="nt-label">Local</span>
            <span className="nt-desc">A shell on this machine</span>
          </button>
          <button className="nt-choice" onClick={onRemote}>
            <span className="nt-ico">
              <IconRemote size={28} />
            </span>
            <span className="nt-label">Remote (SSH)</span>
            <span className="nt-desc">Connect to a server</span>
          </button>
          <button className="nt-choice" onClick={onBrowser}>
            <span className="nt-ico">
              <IconBrowser size={28} />
            </span>
            <span className="nt-label">Browser</span>
            <span className="nt-desc">Open a web page in a pane</span>
          </button>
          <button className="nt-choice" onClick={onGrid}>
            <span className="nt-ico">
              <IconGrid size={28} />
            </span>
            <span className="nt-label">Grid</span>
            <span className="nt-desc">Create a pane arrangement</span>
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
