import { useEffect, useRef } from 'react'
import { useTransfers } from '../store/transfers'

/**
 * Mount-once effect that wires the renderer-side transfer store to the
 * main process's persistent queue:
 *
 *  - `transfers.onStatus` pushes a full list snapshot on every change
 *    (initial subscribe fires the snapshot, then ticks on every add /
 *    patch / remove).
 *  - For each new id that appears in the list, we attach a per-id
 *    `transfers.onProgress` listener so the live overlay (the 250ms
 *    throttled chunk count) can be shown in the row.
 *
 * Cleanup: when an id disappears from the list, the listener is detached.
 */
export function useTransfersSync(): void {
  const setItems = useTransfers((s) => s.setItems)
  const applyEvent = useTransfers((s) => s.applyEvent)
  const listeners = useRef(new Map<string, () => void>())

  useEffect(() => {
    const offList = window.devterm.transfers.onStatus((items) => {
      setItems(items)
      // Reconcile per-item live listeners. New ids get a fresh subscriber;
      // ids no longer present get unsubscribed.
      const present = new Set(items.map((it) => it.id))
      for (const [id, off] of listeners.current) {
        if (!present.has(id)) {
          off()
          listeners.current.delete(id)
        }
      }
      for (const it of items) {
        if (!listeners.current.has(it.id)) {
          const off = window.devterm.transfers.onProgress(it.id, (ev) => {
            applyEvent(it.id, ev)
          })
          listeners.current.set(it.id, off)
        }
      }
    })

    return () => {
      offList()
      for (const off of listeners.current.values()) off()
      listeners.current.clear()
    }
  }, [setItems, applyEvent])
}
