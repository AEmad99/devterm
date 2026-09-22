import { useEffect, useMemo, useRef } from 'react'
import { IconArrowDown, IconArrowUp, IconClose } from '../common/Icons'
import Button from '../common/Button'
import { useTransfers, selectVisible } from '../../store/transfers'
import { useSettings } from '../../store/settings'
import { toast } from '../../store/toasts'
import { useShallow } from 'zustand/react/shallow'
import {
  computeStats,
  pushSample,
  formatRate,
  formatEta,
  type RateSample
} from '../../lib/transfer-stats'
import type { TransferItemV2 } from '@shared/types'

/**
 * Bottom-docked panel showing the persistent transfer queue. One row per
 * TransferItemV2 with direction, name, a progress bar, status text, and
 * per-item Cancel / Retry / Open-in-folder actions. Open/closed state is
 * persisted in the settings store. The status bar Transfers button flips it.
 */
export default function TransfersPanel() {
  const open = useSettings((s) => s.transfersPanelOpen)
  const setOpen = useSettings((s) => s.setTransfersPanelOpen)
  // useShallow: selectVisible returns a fresh filtered array on every snapshot
  // read; without shallow equality useSyncExternalStore sees a "changed" store
  // on every render and loops (React #185 — crashed the whole app on boot).
  const items = useTransfers(useShallow(selectVisible))
  const progress = useTransfers((s) => s.progress)
  const setItems = useTransfers((s) => s.setItems)

  if (!open) return null
  return (
    <div className="transfers-panel">
      <div className="transfers-head">
        <span className="transfers-title">Transfers</span>
        <span className="transfers-count">{items.length}</span>
        <span className="spacer" />
        <Button
          size="xs"
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
        </Button>
        <Button
          variant="icon"
          size="xs"
          className="transfers-close"
          onClick={() => setOpen(false)}
          aria-label="Hide panel"
          title="Hide panel"
        >
          <IconClose size={14} />
        </Button>
      </div>
      {items.length === 0 ? (
        <div className="transfers-empty">
          No transfers yet. Drag a file from one file pane to another, or use the per-row Upload /
          Download buttons. Incomplete files stay as *.partial until they finish or you resume.
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
              onResume={() => void window.devterm.transfers.resume(it.id)}
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
  if (it.paused && !it.done) return 'paused'
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
  onRetry,
  onResume
}: {
  item: TransferItemV2
  live?: { transferred: number; total: number }
  onCancel: () => void
  onRetry: () => void
  onResume: () => void
}) {
  // The live overlay wins for in-flight items (it can lead the persisted
  // snapshot by a tick when the throttle is at the 250ms boundary).
  const transferred = !item.done && live ? live.transferred : item.transferred
  const total = !item.done && live ? live.total : item.total
  const percent = pct(transferred, total)
  const status = statusOf(item)
  const name = basename(item.direction === 'upload' ? item.remotePath : item.localPath)

  // Rate/ETA sampling: each progress tick appends a (time, bytes) sample;
  // stats lag by one tick (250ms), which is invisible at this throttle.
  const samplesRef = useRef<RateSample[]>([])
  useEffect(() => {
    if (status !== 'running') {
      samplesRef.current = []
      return
    }
    pushSample(samplesRef.current, { t: Date.now(), bytes: transferred })
  }, [status, transferred])
  const stats = useMemo(
    () => computeStats(samplesRef.current, total, transferred),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [status, transferred, total]
  )

  const reveal = () => {
    void window.devterm.shell
      .reveal(item.localPath)
      .catch((e) => toast(`Couldn't reveal file: ${(e as Error).message || e}`, 'err'))
  }

  return (
    <li
      className={`transfers-row status-${status}${status === 'done' ? ' is-done' : ''}`}
      onDoubleClick={status === 'done' ? reveal : undefined}
      title={status === 'done' ? 'Double-click to reveal in file manager' : undefined}
    >
      <span className="transfers-dir" title={item.direction}>
        {item.direction === 'upload' ? <IconArrowUp size={12} /> : <IconArrowDown size={12} />}
      </span>
      <span
        className="transfers-name"
        title={item.direction === 'upload' ? item.localPath : item.remotePath}
      >
        {name}
      </span>
      <div className="transfers-bar">
        <div
          className={`transfers-fill ${status === 'error' ? 'err' : status === 'canceled' || status === 'interrupted' || status === 'paused' ? 'cancel' : status === 'done' ? 'done' : ''}`}
          style={{ width: `${percent}%` }}
        />
      </div>
      <span className="transfers-status" title={status === 'error' ? item.error : undefined}>
        {status === 'running' ? `${percent}%` : status}
      </span>
      {status === 'running' && (
        <span
          className="transfers-meta"
          title={`Rate ${formatRate(stats.rateBps)} · ETA ${formatEta(stats.etaSec)}`}
        >
          {formatRate(stats.rateBps)} · {formatEta(stats.etaSec)}
        </span>
      )}
      {(status === 'error' || status === 'paused') && item.error && (
        <span className="transfers-err" title={item.error}>
          {item.error}
        </span>
      )}
      {status === 'paused' && !item.error && (
        <span className="transfers-err" title="Incomplete file kept as *.partial">
          resume from offset
        </span>
      )}
      {status === 'running' ? (
        <Button size="xs" className="transfers-row-action" onClick={onCancel}>
          Cancel
        </Button>
      ) : status === 'paused' ? (
        <Button
          size="xs"
          variant="primary"
          className="transfers-row-action transfers-row-retry"
          onClick={onResume}
        >
          Resume
        </Button>
      ) : status === 'error' || status === 'canceled' || status === 'interrupted' ? (
        <Button
          size="xs"
          variant="primary"
          className="transfers-row-action transfers-row-retry"
          onClick={onRetry}
        >
          Retry
        </Button>
      ) : status === 'done' ? (
        <Button
          size="xs"
          className="transfers-row-action"
          onClick={reveal}
          title="Reveal in file manager"
        >
          Reveal
        </Button>
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
