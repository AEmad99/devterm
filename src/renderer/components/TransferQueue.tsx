import type { TransferProgress, TransferDirection } from '@shared/types'

export interface TransferItem extends TransferProgress {
  direction: TransferDirection
  name: string
}

function pct(t: TransferItem): number {
  if (t.total <= 0) return t.done ? 100 : 0
  return Math.min(100, Math.round((t.transferred / t.total) * 100))
}

export default function TransferQueue({
  items,
  onCancel,
  onClear
}: {
  items: TransferItem[]
  onCancel: (id: string) => void
  onClear: () => void
}) {
  if (items.length === 0) return null
  return (
    <div className="transfer-queue">
      <div className="tq-head">
        <span>Transfers</span>
        <button className="ghost" onClick={onClear}>Clear finished</button>
      </div>
      {items.map((t) => (
        <div key={t.id} className="tq-item">
          <span className="tq-dir">{t.direction === 'upload' ? '⬆' : '⬇'}</span>
          <span className="tq-name" title={t.name}>{t.name}</span>
          <div className="tq-bar">
            <div
              className={`tq-fill ${t.error ? 'err' : t.canceled ? 'cancel' : t.done ? 'done' : ''}`}
              style={{ width: `${pct(t)}%` }}
            />
          </div>
          <span className="tq-status">
            {t.error ? 'error' : t.canceled ? 'canceled' : t.done ? 'done' : `${pct(t)}%`}
          </span>
          {!t.done ? (
            <button className="ghost" onClick={() => onCancel(t.id)}>Cancel</button>
          ) : (
            <span className="tq-spacer" />
          )}
        </div>
      ))}
    </div>
  )
}
