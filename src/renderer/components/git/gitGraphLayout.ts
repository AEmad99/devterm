/**
 * Lane assignment for the Git Graph view.
 *
 * Port of `git log --graph`'s lane allocator (the algorithm in git's
 * `graph.c` `graph_update` routine). Each commit is laid out on a vertical
 * "lane"; lanes branch off to the right when a commit has multiple parents
 * and merge back when a child commit re-uses a lane.
 *
 * Inputs: commits already in topological order (provided by `git log
 * --topo-order` over the wire, see `src/main/git.ts` `logArgs`).
 *
 * Output: per-row layout describing which lane each commit occupies, which
 * lanes have active children entering and leaving the row, and which lanes
 * additional (non-first) parents were placed on for merge commits. The SVG
 * renderer (`GitGraphView.tsx`) consumes this directly.
 */
import type { GitLogEntry } from '@shared/types'

export interface LaneRow {
  sha: string
  /** 0-indexed lane this commit occupies. */
  lane: number
  parents: string[]
  /** Lanes (by index) with active children at the START of this row. */
  lanesBefore: number[]
  /** Lanes (by index) with active children at the END of this row (after the
   *  commit's own parents have been placed). */
  lanesAfter: number[]
  /** Lane the first parent occupies for the next row (-1 if no parents). */
  firstParentLane: number
  /** Lanes additional (non-first) parents were placed on for merge commits. */
  mergeLanes: number[]
  isMerge: boolean
}

export interface GraphLayout {
  rows: LaneRow[]
  /** Highest lane index used anywhere in the graph; used by the renderer to
   *  compute the SVG width. */
  maxLane: number
}

/**
 * Lay out commits into lanes. Pure: no React, no DOM. Safe to call inside
 * `useMemo` on `entries`.
 */
export function layoutGraph(entries: GitLogEntry[]): GraphLayout {
  const rows: LaneRow[] = []
  // `lanes[i]` is the SHA of the child currently occupying lane `i`, or
  // `undefined` if the lane is free.
  const lanes: (string | undefined)[] = []
  let maxLane = -1

  const firstFree = (): number => {
    for (let i = 0; i < lanes.length; i++) if (lanes[i] === undefined) return i
    return lanes.length
  }

  const occupiedIndices = (): number[] => {
    const out: number[] = []
    for (let i = 0; i < lanes.length; i++) if (lanes[i] !== undefined) out.push(i)
    return out
  }

  for (const entry of entries) {
    // Re-use a lane whose "next child" is this commit (a join). Otherwise
    // take the first free lane.
    let lane = lanes.indexOf(entry.sha)
    if (lane === -1) lane = firstFree()

    const lanesBefore = occupiedIndices()

    // Vacate this lane; place parents back into the lane stack. First parent
    // inherits the commit's lane; extra parents each get a fresh lane to the
    // right.
    lanes[lane] = undefined
    const firstParent = entry.parents[0] ?? null
    if (firstParent) lanes[lane] = firstParent

    const mergeLanes: number[] = []
    for (let p = 1; p < entry.parents.length; p++) {
      const newLane = firstFree()
      lanes[newLane] = entry.parents[p]
      mergeLanes.push(newLane)
    }

    const lanesAfter = occupiedIndices()
    for (const l of lanesAfter) if (l > maxLane) maxLane = l
    if (lane > maxLane) maxLane = lane

    rows.push({
      sha: entry.sha,
      lane,
      parents: entry.parents,
      lanesBefore,
      lanesAfter,
      firstParentLane: firstParent ? lane : -1,
      mergeLanes,
      isMerge: entry.parents.length > 1
    })
  }

  return { rows, maxLane }
}
