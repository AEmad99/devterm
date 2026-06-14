// Renderer-side bridge activity subscriber.
//
// The panel needs:
//   1. A live feed of new entries (the per-session push channel).
//   2. A backfill of recent history on mount (the per-session list).
// The two are stitched together by `subscribeBridgeActivity`: it loads the
// recent window once, then appends every live entry that arrives. The store
// is intentionally tiny — the panel filters and slices it; the panel itself
// owns the visual state (filter chips, expanded row).

import { useEffect, useState } from 'react'
import type { BridgeActivityEntry } from '@shared/types'

const MAX_ROWS = 100

export interface BridgeActivityFeed {
  /** Most recent entries, newest last. Capped at MAX_ROWS. */
  entries: BridgeActivityEntry[]
  /** True until the initial backfill resolves. */
  loading: boolean
  /** Drop the in-memory view; the on-disk tail is intentionally kept. */
  clear: () => void
}

/**
 * Subscribe to the live bridge activity feed for `sessionId`. Pulls the
 * recent in-memory + tail window on mount, then appends pushed entries.
 * The returned `entries` is sorted oldest → newest (chronological), so a
 * flat list with no further sort in the panel is correct.
 */
export function useBridgeActivity(sessionId: string): BridgeActivityFeed {
  const [entries, setEntries] = useState<BridgeActivityEntry[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setEntries([])
    setLoading(true)
    // 1. Backfill: ask main for the recent window (in-memory ring + tail).
    void window.devterm.bridgeActivity
      .list(sessionId, { limit: MAX_ROWS })
      .then((rows) => {
        if (cancelled) return
        setEntries(rows.slice(-MAX_ROWS))
        setLoading(false)
      })
      .catch(() => {
        if (cancelled) return
        setLoading(false)
      })
    // 2. Live push: every entry that arrives after the backfill gets appended.
    // The IPC push is delivered as a single entry; the main-side ring keeps
    // a 500-entry window, so backfill + live gives a correct view.
    const dispose = window.devterm.bridgeActivity.on(sessionId, (entry) => {
      if (cancelled) return
      setEntries((prev) => {
        const next = prev.concat(entry)
        return next.length > MAX_ROWS ? next.slice(next.length - MAX_ROWS) : next
      })
    })
    return () => {
      cancelled = true
      dispose()
    }
  }, [sessionId])

  return {
    entries,
    loading,
    clear: () => {
      setEntries([])
      void window.devterm.bridgeActivity.clear(sessionId)
    }
  }
}

/**
 * Format a duration in ms as a compact human string. Sub-second calls show
 * milliseconds; anything >= 1s shows seconds with one decimal.
 */
export function formatDuration(ms: number | undefined): string {
  if (ms == null) return ''
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

/** Format a timestamp as HH:MM:SS in local time. */
export function formatTime(ts: number): string {
  const d = new Date(ts)
  const h = String(d.getHours()).padStart(2, '0')
  const m = String(d.getMinutes()).padStart(2, '0')
  const s = String(d.getSeconds()).padStart(2, '0')
  return `${h}:${m}:${s}`
}
