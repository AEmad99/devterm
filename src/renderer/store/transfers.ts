import { create } from 'zustand'
import type { TransferItemV2, TransferEvent } from '@shared/types'

/**
 * Renderer-side mirror of the main process's persistent transfer queue.
 * The list comes from `transfers.onStatus` (which fires the initial snapshot
 * and re-fires on every change), and per-item live events are throttled by
 * main to 250ms.
 *
 * The store is intentionally minimal: it's a cache of main's truth, not a
 * separate source of it. All mutations go through IPC; this store just
 * keeps the UI in sync.
 */
interface TransfersState {
  items: TransferItemV2[]
  /** Per-item throttled progress overlay; merged into `items` on done. */
  progress: Record<string, { transferred: number; total: number }>
  /**
   * Coarse clock (refreshed every minute) backing selectVisible's 24h cutoff,
   * so finished items age out even when the queue itself is idle.
   */
  now: number
  setItems: (items: TransferItemV2[]) => void
  applyEvent: (id: string, ev: TransferEvent) => void
  clear: () => void
}

export const useTransfers = create<TransfersState>((set) => ({
  items: [],
  progress: {},
  now: Date.now(),
  setItems: (items) => {
    // Don't blow away the live progress overlay for items the user can still see.
    set((cur) => {
      const next: Record<string, { transferred: number; total: number }> = {}
      for (const it of items) {
        const live = cur.progress[it.id]
        if (live && !it.done) {
          next[it.id] = live
        }
      }
      return { items, progress: next }
    })
  },
  applyEvent: (id, ev) => {
    if (ev.kind === 'progress') {
      set((cur) => ({
        progress: { ...cur.progress, [id]: { transferred: ev.transferred, total: ev.total } }
      }))
    } else if (ev.kind === 'done') {
      set((cur) => {
        const { [id]: _, ...rest } = cur.progress
        void _
        return {
          progress: rest,
          items: cur.items.map((it) =>
            it.id === id
              ? {
                  ...it,
                  done: true,
                  transferred: ev.transferred,
                  total: ev.total,
                  canceled: ev.canceled,
                  error: ev.error,
                  finishedAt: ev.finishedAt
                }
              : it
          )
        }
      })
    }
  },
  clear: () => set({ items: [], progress: {} })
}))

// Refresh the cutoff clock once a minute. selectVisible consumers use
// useShallow, so a tick that doesn't change membership is a no-op render-wise
// (item references stay stable).
if (typeof window !== 'undefined') {
  setInterval(() => useTransfers.setState({ now: Date.now() }), 60 * 1000)
}

/** Open the live transfer store to a single item (the row the UI is rendering). */
export function selectItem(id: string) {
  return (s: TransfersState) => s.items.find((x) => x.id === id) ?? null
}

/** Active + recent (last 24h) items, newest first. */
export function selectVisible(s: TransfersState): TransferItemV2[] {
  // The store is already most-recent-first (we unshift on enqueue).
  const DAY = 24 * 60 * 60 * 1000
  return s.items.filter((it) => !it.done || (it.finishedAt && s.now - it.finishedAt < DAY))
}
