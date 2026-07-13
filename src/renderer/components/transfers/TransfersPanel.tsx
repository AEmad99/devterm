import { useTransfers, selectVisible } from '../../store/transfers'
import { useSettings } from '../../store/settings'
import type { TransferItemV2 } from '@shared/types'

/**
 * Bottom-docked panel showing the persistent transfer queue. One row per
 * TransferItemV2 with direction, name, a progress bar, status text, and
 * per-item Cancel / Retry / Open-in-folder actions. Open/closed state is
 * persisted in the settings store; the App toolbar's "Activity | Transfers |
 * Off" segmented control is the canonical way to flip it.
 */
export default function TransfersPanel() {
  const open = useSettings((s) => s.transfersPanelOpen)
  const setOpen = useSettings((s) => s.setTransfersPanelOpen)
  const items = useTransfers(selectVisible)
  const progress = useTransfers((s) => s.progress)
  const setItems = useTransfers((s) => s.setItems)

  if (!open) return null
  return (
    <div className="transfers-panel">
      <div className="transfers-head">
        <span className="transfers-title">Transfers</span>
        <span className="transfers-count">{items.length}</span>
        <span className="spacer" />
        <button
          className="transfers-action"
          onClick={async () => {
            // `clearFinished` returns the post-clear list from main; sync the
            // renderer cache to it so errored/interrupted rows that survived
            // the previous filter bug actually disappear.
            const remaining = await window.devterm.transfers.clearFinished()
            setItems(remaining)
          }}
          disabled={items.every((it) => !it.done)}
        >
          Clear finished
        </button>
        <button
          className="transfers-close"
          onClick={() => setOpen(false)}
          aria-label="Hide panel"
          title="Hide panel"
        >
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <path
              d="M3.5 3.5l9 9M12.5 3.5l-9 9"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>
      {items.length === 0 ? (
        <div className="transfers-empty">
          No transfers yet. Drag a file from one file pane to another, or use the per-row Upload /
          Download buttons.
        </div>
      ) : (
        <ul className="transfers-list">
          {items.map((it) => (
            <TransferRow
              key={it.id}
              item={it}
              live={progress[it.id]}
              onCancel={() => void window.devterm.transfers.cancel(it.id)}
              onRetry={() => void window.devterm.transfers.retry(it.id)}
            />
          ))}
        </ul>
      )}
    </div>
  )
}

function pct(transferred: number, total: number): number {
  if (total <= 0) return 0
  return Math.min(100, Math.round((transferred / total) * 100))
}

function statusOf(it: TransferItemV2): string {
  if (it.error === 'interrupted by restart') return 'interrupted'
  if (it.error) return 'error'
  if (it.canceled) return 'canceled'
  if (it.done) return 'done'
  return 'running'
}

function TransferRow({
  item,
  live,
  onCancel,
  onRetry
}: {
  item: TransferItemV2
  live?: { transferred: number; total: number }
  onCancel: () => void
  onRetry: () => void
}) {
  // The live overlay wins for in-flight items (it can lead the persisted
  // snapshot by a tick when the throttle is at the 250ms boundary).
  const transferred = !item.done && live ? live.transferred : item.transferred
  const total = !item.done && live ? live.total : item.total
  const percent = pct(transferred, total)
  const status = statusOf(item)
  const name = basename(item.direction === 'upload' ? item.remotePath : item.localPath)
  return (
    <li className={`transfers-row status-${status}`}>
      <span className="transfers-dir">{item.direction === 'upload' ? '⬆' : '⬇'}</span>
      <span
        className="transfers-name"
        title={item.direction === 'upload' ? item.localPath : item.remotePath}
      >
        {name}
      </span>
      <div className="transfers-bar">
        <div
          className={`transfers-fill ${status === 'error' ? 'err' : status === 'canceled' || status === 'interrupted' ? 'cancel' : status === 'done' ? 'done' : ''}`}
          style={{ width: `${percent}%` }}
        />
      </div>
      <span className="transfers-status">{status === 'running' ? `${percent}%` : status}</span>
      {!item.done ? (
        <button className="transfers-row-action" onClick={onCancel}>
          Cancel
        </button>
      ) : status === 'error' || status === 'canceled' || status === 'interrupted' ? (
        <button className="transfers-row-action transfers-row-retry" onClick={onRetry}>
          Retry
        </button>
      ) : (
        <span className="transfers-spacer" />
      )}
    </li>
  )
}

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i >= 0 ? p.slice(i + 1) : p
}
