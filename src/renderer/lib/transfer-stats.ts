/**
 * Transfer rate / ETA math for the transfers panel. Pure functions over
 * (bytes, timestamp) samples so the panel can feed live progress events and
 * the units can be tested without a store.
 */

export interface RateSample {
  /** Unix ms (Date.now()). */
  t: number
  /** Cumulative bytes transferred. */
  bytes: number
}

export interface TransferStats {
  /** Bytes/second over the sample window, or null when unknown. */
  rateBps: number | null
  /** Estimated seconds remaining, or null when unknown. */
  etaSec: number | null
  /** Overall percent 0–100. */
  percent: number
}

/**
 * Compute rate + ETA from the oldest and newest samples in the window plus
 * the transfer total. Needs at least two samples with forward progress and a
 * positive total; anything else yields nulls (caller shows "—").
 */
export function computeStats(
  samples: RateSample[],
  total: number,
  nowBytes: number
): TransferStats {
  const percent = total > 0 ? Math.min(100, Math.round((nowBytes / total) * 100)) : 0
  if (samples.length < 2 || total <= 0) return { rateBps: null, etaSec: null, percent }
  const first = samples[0]
  const last = samples[samples.length - 1]
  const dtSec = (last.t - first.t) / 1000
  const dBytes = last.bytes - first.bytes
  if (dtSec <= 0 || dBytes <= 0) return { rateBps: null, etaSec: null, percent }
  const rateBps = dBytes / dtSec
  const remaining = Math.max(0, total - nowBytes)
  const etaSec = rateBps > 0 ? remaining / rateBps : null
  return { rateBps, etaSec, percent }
}

/** Push a sample, keeping at most `max` (oldest evicted). Mutates the array. */
export function pushSample(samples: RateSample[], sample: RateSample, max = 8): RateSample[] {
  const last = samples[samples.length - 1]
  // Coalesce same-tick samples (throttled progress can re-fire per render).
  if (last && sample.t <= last.t) {
    last.bytes = Math.max(last.bytes, sample.bytes)
    return samples
  }
  samples.push(sample)
  while (samples.length > max) samples.shift()
  return samples
}

/** "1.2 MB/s", "840 B/s" — null-safe. */
export function formatRate(bps: number | null): string {
  if (bps == null || !Number.isFinite(bps) || bps <= 0) return '—'
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s']
  let v = bps
  let u = 0
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024
    u++
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[u]}`
}

/** "0:42", "12:05", "1:02:30" — null-safe. */
export function formatEta(sec: number | null): string {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return '—'
  const s = Math.round(sec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const rest = s % 60
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m)
  const ss = String(rest).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}
