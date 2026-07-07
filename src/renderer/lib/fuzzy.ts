/**
 * Small dependency-free fuzzy scorer used by the command palette.
 *
 * For each query term we scan the target left-to-right, matching characters
 * in order. A term scores higher when matches are consecutive, start at word
 * boundaries, or form an exact substring. Multiple terms are AND-ed; the final
 * score is the sum of per-term scores. `null` means "no match".
 */

export interface FuzzyMatch {
  score: number
  /** Indices in the lower-cased target where query characters matched. */
  matches: number[]
}

function isWordChar(ch: string): boolean {
  return /[a-z0-9]/.test(ch)
}

function isBoundary(target: string, idx: number): boolean {
  if (idx === 0) return true
  return isWordChar(target[idx]) && !isWordChar(target[idx - 1])
}

export function scoreFuzzy(target: string, query: string): FuzzyMatch | null {
  if (!query) return { score: 0, matches: [] }
  const t = target.toLowerCase()
  const q = query.toLowerCase()
  const matches: number[] = []
  let idx = -1
  let score = 0
  let consecutive = 0

  for (let i = 0; i < q.length; i++) {
    const ch = q[i]
    const next = t.indexOf(ch, idx + 1)
    if (next === -1) return null
    matches.push(next)

    score += 10
    if (i > 0 && next === idx + 1) {
      consecutive++
      score += 12 + consecutive * 6
    } else {
      consecutive = 0
    }
    if (isBoundary(t, next)) score += 18
    idx = next
  }

  if (t.includes(q)) score += 60
  score -= t.length * 0.08
  return { score, matches }
}

export function scoreTerms(target: string, query: string): FuzzyMatch | null {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!terms.length) return { score: 0, matches: [] }
  let total = 0
  const allMatches: number[] = []
  for (const term of terms) {
    const res = scoreFuzzy(target, term)
    if (!res) return null
    total += res.score
    allMatches.push(...res.matches)
  }
  return { score: total, matches: allMatches }
}
