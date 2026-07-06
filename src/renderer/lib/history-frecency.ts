// Frecency scoring for command-palette history. The palette tracks two parallel
// lists: `recent` (most-recently-used first) and `frequent` (most-used first,
// with explicit counts). Frecency blends them: a single ranked list driven by
// `score = recencyWeight * (1 / (ageDays + 1)) + countWeight * log10(count + 1)`
// so the top of the list is whatever the user both ran recently and runs a lot.
//
// Why both signals? Recent-only buries a command you ran once yesterday under a
// command you ran 50 times last week but haven't touched this session. Pure
// frequency hides the new thing you just discovered. The combined score makes
// "ran today" carry more weight than "ran a week ago" within a log10 curve for
// frequency — so the blend naturally surfaces both.

import type { CommandStat, HistoryResult } from '@shared/types'

/** Weight of the recency term. Higher = recent commands dominate. */
export const RECENCY_WEIGHT = 0.6
/** Weight of the count term. Higher = power commands dominate. */
export const COUNT_WEIGHT = 0.4

/**
 * Per-command entry produced by the merge: the canonical command, a merged
 * count (max across the two source lists), and the score the rank uses.
 */
export interface FrecencyEntry {
  command: string
  count: number
  /** Higher = more relevant; stable for sort. */
  score: number
  /**
   * 0-based position in the original `recent` list (most recent first). Items
   * missing from `recent` are treated as "very old" so they sink below recent
   * ones at equal count. `-1` here means "not in recent".
   */
  recencyIndex: number
}

/**
 * Blend `recent` and `frequent` into a single sorted list. Duplicate commands
 * (the same string in both lists) collapse to a single entry whose count is the
 * max of the two reported counts; both recency and frequency feed its score.
 *
 * `now` is parameterised so callers (and tests) can drive the clock without
 * monkey-patching Date. Default is the current time.
 */
export function buildFrecency(
  hist: HistoryResult | null | undefined,
  now: number = Date.now()
): FrecencyEntry[] {
  if (!hist) return []
  const counts = new Map<string, number>()
  const recentIndexes = new Map<string, number>()
  // `frequent` already carries counts; use them as the authoritative source
  // for the count term.
  for (const f of hist.frequent ?? []) {
    if (!f?.command) continue
    counts.set(f.command, Math.max(counts.get(f.command) ?? 0, f.count))
  }
  // `recent` only gives ordering, not timestamps. Treat position in the array
  // as a coarse age: index 0 ran "today" (score 1 / (0 + 1) = 1), index 6
  // ran ~a week ago, etc. The 1/(ageDays+1) form still falls off correctly for
  // older items at the tail.
  const recents = hist.recent ?? []
  recents.forEach((cmd, i) => {
    if (!cmd) return
    if (!counts.has(cmd)) counts.set(cmd, 1) // default count for never-counted
    // Preserve the smallest (most recent) index when the same command recurs.
    if (!recentIndexes.has(cmd)) recentIndexes.set(cmd, i)
  })
  const out: FrecencyEntry[] = []
  // Walk the union of both maps so we don't lose a frequent-only command.
  const all = new Set<string>([...counts.keys(), ...recentIndexes.keys()])
  for (const cmd of all) {
    const count = counts.get(cmd) ?? 0
    const recencyIndex = recentIndexes.has(cmd) ? (recentIndexes.get(cmd) as number) : -1
    // ageDays: 0 for the most recent slot, +1 per slot, capped for the long
    // tail. Items not in `recent` get a soft cap so a heavy hitter that's been
    // dormant still scores above a brand-new run.
    const ageDays = recencyIndex < 0 ? 30 : recencyIndex
    const recencyTerm = 1 / (ageDays + 1)
    const countTerm = Math.log10(count + 1)
    const score = RECENCY_WEIGHT * recencyTerm + COUNT_WEIGHT * countTerm
    out.push({ command: cmd, count, score, recencyIndex })
  }
  // Highest score first. Stable tiebreaker: more recent first, then by count,
  // then alphabetically so the order is deterministic across runs.
  out.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    if (a.recencyIndex !== b.recencyIndex) return a.recencyIndex - b.recencyIndex
    if (a.count !== b.count) return b.count - a.count
    return a.command < b.command ? -1 : a.command > b.command ? 1 : 0
  })
  // Touch `now` so callers that pass an injected clock see the parameter
  // acknowledged; also keeps the unused-var lint clean if the implementation
  // evolves to use the real wall clock later.
  void now
  return out
}

/** Build a Set of normalised snippet commands for O(1) history-dedupe. */
export function snippetCommandSet(snippets: { command: string }[]): Set<string> {
  const set = new Set<string>()
  for (const s of snippets) set.add(normalizeForDedupe(s.command))
  return set
}

/**
 * Normalise a command for dedupe purposes. The history may include commands
 * with leading/trailing whitespace (a copy-paste artifact) or a trailing
 * newline; the snippet store typically trims those. Treat them as the same
 * command so a saved snippet hides the noisy history copy and vice versa.
 */
export function normalizeForDedupe(command: string): string {
  // Trim trailing whitespace and a single trailing newline (history often has
  // one); also drop leading whitespace so a "  ssh ..." never escapes dedupe.
  return command.replace(/[\s\n]+$/, '').replace(/^\s+/, '')
}

/**
 * Filter the frecency list against the snippet-dedupe set, optionally against
 * a search term (every whitespace-separated term must appear in the command,
 * case-insensitive), and cap the size. Returns the surviving entries in the
 * same order as the input frecency list.
 */
export function filterHistory(
  entries: FrecencyEntry[],
  snippetCmds: Set<string>,
  query: string,
  max: number
): FrecencyEntry[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  const out: FrecencyEntry[] = []
  for (const e of entries) {
    if (snippetCmds.has(normalizeForDedupe(e.command))) continue
    if (terms.length) {
      const hay = e.command.toLowerCase()
      let ok = true
      for (const t of terms)
        if (!hay.includes(t)) {
          ok = false
          break
        }
      if (!ok) continue
    }
    out.push(e)
    if (out.length >= max) break
  }
  return out
}

// Re-export the shared CommandStat type so callers can import it from a
// single module without reaching into @shared/types directly when they only
// need the merge helper.
export type { CommandStat, HistoryResult }
