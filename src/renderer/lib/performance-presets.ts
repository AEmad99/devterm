import {
  DEFAULT_HIBERNATE_AFTER_MS,
  DEFAULT_OUTPUT_RING_LINES,
  MAX_OUTPUT_RING_LINES,
  normalizeHibernateAfterMs,
  normalizeOutputRingLines
} from './hibernate'

export type PerformancePresetId = 'balanced' | 'low-memory' | 'full-fidelity'

export const DEFAULT_SEARCH_INDEX_LINES = 2000
export const MIN_SEARCH_INDEX_LINES = 200
export const MAX_SEARCH_INDEX_LINES = 10_000

export function normalizeSearchIndexLines(
  value: unknown,
  fallback = DEFAULT_SEARCH_INDEX_LINES
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.max(MIN_SEARCH_INDEX_LINES, Math.min(MAX_SEARCH_INDEX_LINES, Math.floor(value)))
}

export interface PerformancePresetValues {
  hibernateEnabled: boolean
  hibernateAfterMs: number
  scrollback: number
  outputRingLines: number
  searchIndexLines: number
  remoteConnectMode: 'focus' | 'stagger'
}

export const PERFORMANCE_PRESETS: Record<
  PerformancePresetId,
  { label: string; hint: string; values: PerformancePresetValues }
> = {
  balanced: {
    label: 'Balanced',
    hint: 'Hibernate at 30s, 10k scrollback, 2k search, remotes on focus.',
    values: {
      hibernateEnabled: true,
      hibernateAfterMs: DEFAULT_HIBERNATE_AFTER_MS,
      scrollback: 10_000,
      outputRingLines: DEFAULT_OUTPUT_RING_LINES,
      searchIndexLines: DEFAULT_SEARCH_INDEX_LINES,
      remoteConnectMode: 'focus'
    }
  },
  'low-memory': {
    label: 'Low memory',
    hint: 'Hibernate at 10s, 2k scrollback, 1k search, remotes on focus.',
    values: {
      hibernateEnabled: true,
      hibernateAfterMs: 10_000,
      scrollback: 2000,
      outputRingLines: 2000,
      searchIndexLines: 1000,
      remoteConnectMode: 'focus'
    }
  },
  'full-fidelity': {
    label: 'Full fidelity',
    hint: 'Keep every renderer terminal live; scrollback at the 100k clamp.',
    values: {
      hibernateEnabled: false,
      hibernateAfterMs: DEFAULT_HIBERNATE_AFTER_MS,
      scrollback: MAX_OUTPUT_RING_LINES,
      outputRingLines: MAX_OUTPUT_RING_LINES,
      searchIndexLines: DEFAULT_SEARCH_INDEX_LINES,
      remoteConnectMode: 'stagger'
    }
  }
}

export interface PerformanceSnapshotLike {
  hibernateEnabled: boolean
  hibernateAfterMs: number
  scrollback: number
  outputRingLines: number
  searchIndexLines: number
  remoteConnectMode: 'focus' | 'stagger'
}

export function matchPerformancePreset(
  snapshot: PerformanceSnapshotLike
): PerformancePresetId | 'custom' {
  for (const id of Object.keys(PERFORMANCE_PRESETS) as PerformancePresetId[]) {
    const v = PERFORMANCE_PRESETS[id].values
    if (
      snapshot.hibernateEnabled === v.hibernateEnabled &&
      normalizeHibernateAfterMs(snapshot.hibernateAfterMs) === v.hibernateAfterMs &&
      snapshot.scrollback === v.scrollback &&
      normalizeOutputRingLines(snapshot.outputRingLines) === v.outputRingLines &&
      normalizeSearchIndexLines(snapshot.searchIndexLines) === v.searchIndexLines &&
      snapshot.remoteConnectMode === v.remoteConnectMode
    ) {
      return id
    }
  }
  return 'custom'
}
