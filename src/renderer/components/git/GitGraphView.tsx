/**
 * VSCode Git Graph-style render of a commit log.
 *
 * Each row is a flex row containing an inline SVG (the lane art) plus the
 * commit message and meta columns. The SVG lane-art columns are fixed-width
 * per the lane count, and the message column ellipsises on overflow.
 *
 * Lanes are drawn as vertical lines that continue from one row to the next;
 * parent connectors are S-curves from the commit dot down to the parent
 * lane. Merge commits draw their non-first-parent connectors as dashed lines.
 */
import { useMemo } from 'react'
import type { GitLogEntry } from '@shared/types'
import { layoutGraph } from './gitGraphLayout'

// Layout constants. Tuned to match the visual density of mhutchie's Git Graph.
const LANE_WIDTH = 14
const LANE_PAD_LEFT = 8
const ROW_HEIGHT = 26
const DOT_R = 3.5

/** x-coordinate of the centerline of a given lane. */
function laneX(lane: number): number {
  return LANE_PAD_LEFT + lane * LANE_WIDTH + LANE_WIDTH / 2
}

/**
 * Build an S-curve path from `fromLane`'s centerline at row midpoint down
 * to `toLane`'s centerline at the row bottom.
 */
function curvePath(fromLane: number, toLane: number): string {
  const x1 = laneX(fromLane)
  const y1 = ROW_HEIGHT / 2
  const x2 = laneX(toLane)
  const y2 = ROW_HEIGHT
  const midY = (y1 + y2) / 2
  return `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`
}

export interface GitGraphViewProps {
  entries: GitLogEntry[]
  selected: string | null
  onSelect: (sha: string) => void
  /** Optional relative-time formatter. Falls back to a coarse formatter so the
   *  component works standalone. */
  formatRel?: (iso: string) => string
}

function defaultFormatRel(iso: string): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return iso
  const sec = Math.max(0, (Date.now() - t) / 1000)
  if (sec < 60) return 'just now'
  const min = sec / 60
  if (min < 60) return `${Math.floor(min)}m ago`
  const hr = min / 60
  if (hr < 24) return `${Math.floor(hr)}h ago`
  const day = hr / 24
  if (day < 30) return `${Math.floor(day)}d ago`
  const mon = day / 30
  if (mon < 12) return `${Math.floor(mon)}mo ago`
  return `${Math.floor(mon / 12)}y ago`
}

export default function GitGraphView({
  entries,
  selected,
  onSelect,
  formatRel = defaultFormatRel
}: GitGraphViewProps) {
  const { rows, maxLane } = useMemo(() => layoutGraph(entries), [entries])
  const svgWidth = LANE_PAD_LEFT + (maxLane + 1) * LANE_WIDTH
  const fmt = formatRel

  return (
    <div className="git-graph-list">
      {rows.map((row, idx) => {
        const entry = entries[idx]
        const refs = entry.refs.filter((r) => r && r !== 'HEAD')
        // Lanes with verticals drawn this row: those with active children
        // both BEFORE and AFTER this row's commit.
        const continuingLanes = row.lanesBefore.filter((l) => row.lanesAfter.includes(l))
        return (
          <div
            key={row.sha}
            className={`git-graph-row ${selected === row.sha ? 'sel' : ''}`}
            onClick={() => onSelect(row.sha)}
          >
            <svg
              className="git-graph-svg"
              width={svgWidth}
              height={ROW_HEIGHT}
              viewBox={`0 0 ${svgWidth} ${ROW_HEIGHT}`}
            >
              {/* Vertical lane lines for lanes that continue across this row. */}
              {continuingLanes.map((l) => (
                <line
                  key={`v${l}`}
                  className="git-graph-lane"
                  x1={laneX(l)}
                  y1={0}
                  x2={laneX(l)}
                  y2={ROW_HEIGHT}
                />
              ))}
              {/* Curve to first parent when the parent is on a different lane. */}
              {row.firstParentLane >= 0 && row.firstParentLane !== row.lane && (
                <path
                  className="git-graph-curve"
                  d={curvePath(row.lane, row.firstParentLane)}
                />
              )}
              {/* Dashed curves for non-first parents on merge commits. */}
              {row.mergeLanes.map((ml) => (
                <path
                  key={`m${ml}`}
                  className="git-graph-curve merge"
                  d={curvePath(row.lane, ml)}
                />
              ))}
              {/* The commit dot itself. */}
              <circle
                className="git-graph-dot"
                cx={laneX(row.lane)}
                cy={ROW_HEIGHT / 2}
                r={DOT_R}
              />
            </svg>
            <div className="git-graph-message">
              <span className="git-sha" title={entry.sha}>
                {entry.shortSha}
              </span>
              <span className="git-graph-subject">{entry.subject || '(no subject)'}</span>
            </div>
            <div className="git-graph-meta">
              {refs.length > 0 && <span className="git-refs">{refs.join(' · ')}</span>}
              <span className="git-graph-author">{entry.authorName}</span>
              <span className="git-time" title={entry.authorDate}>
                {fmt(entry.authorDate)}
              </span>
            </div>
          </div>
        )
      })}
    </div>
  )
}