import type { LayoutSnapshot } from '../store/layout'

export const GRID_MAX_ROWS = 4
export const GRID_MAX_COLS = 4
export const GRID_MAX_CELLS = 16
export const GRID_MIN_DIM = 1

export interface GridSpec {
  rows: number
  cols: number
}

export function clampGridSpec(spec: GridSpec): GridSpec {
  const rows = Math.min(GRID_MAX_ROWS, Math.max(GRID_MIN_DIM, Math.floor(spec.rows)))
  const cols = Math.min(GRID_MAX_COLS, Math.max(GRID_MIN_DIM, Math.floor(spec.cols)))
  return { rows, cols }
}

export function gridCellCount(spec: GridSpec): number {
  const { rows, cols } = clampGridSpec(spec)
  return rows * cols
}

/** Validate before create; returns error message or null. */
export function validateGridSpec(spec: GridSpec): string | null {
  if (!Number.isFinite(spec.rows) || !Number.isFinite(spec.cols)) return 'Invalid dimensions'
  if (spec.rows < GRID_MIN_DIM || spec.cols < GRID_MIN_DIM) return 'Minimum is 1×1'
  if (spec.rows > GRID_MAX_ROWS || spec.cols > GRID_MAX_COLS) {
    return `Maximum is ${GRID_MAX_ROWS}×${GRID_MAX_COLS}`
  }
  if (spec.rows * spec.cols > GRID_MAX_CELLS) return `Maximum ${GRID_MAX_CELLS} terminals`
  return null
}

/**
 * Build a LayoutSnapshot placing session ids in row-major order.
 * Strict: throws if ids.length !== rows * cols.
 */
export function buildGridSnapshot(ids: string[], rows: number, cols: number): LayoutSnapshot {
  const expected = rows * cols
  if (ids.length !== expected) {
    throw new Error(
      `buildGridSnapshot: expected ${expected} ids (rows=${rows} cols=${cols}), got ${ids.length}`
    )
  }
  if (rows === 1 && cols === 1) {
    return leafOf(ids[0])
  }
  if (rows === 1) {
    return {
      type: 'split',
      dir: 'row',
      sizes: equalSizes(cols),
      children: ids.map(leafOf)
    }
  }
  if (cols === 1) {
    return {
      type: 'split',
      dir: 'col',
      sizes: equalSizes(rows),
      children: ids.map(leafOf)
    }
  }
  const rowNodes: LayoutSnapshot[] = []
  for (let r = 0; r < rows; r++) {
    const slice = ids.slice(r * cols, r * cols + cols)
    rowNodes.push({
      type: 'split',
      dir: 'row',
      sizes: equalSizes(cols),
      children: slice.map(leafOf)
    })
  }
  return {
    type: 'split',
    dir: 'col',
    sizes: equalSizes(rows),
    children: rowNodes
  }
}

/** Pack n ids into a near-grid when some cells failed (e.g. SSH partial success). */
export function packIdsAsGrid(ids: string[], preferredCols: number): LayoutSnapshot | null {
  if (!ids.length) return null
  const cols = Math.min(preferredCols, GRID_MAX_COLS, ids.length)
  const rows = Math.ceil(ids.length / cols)
  const rowNodes: LayoutSnapshot[] = []
  let i = 0
  for (let r = 0; r < rows; r++) {
    const take = Math.min(cols, ids.length - i)
    const slice = ids.slice(i, i + take)
    i += take
    rowNodes.push(
      slice.length === 1
        ? leafOf(slice[0])
        : {
            type: 'split',
            dir: 'row',
            sizes: equalSizes(slice.length),
            children: slice.map(leafOf)
          }
    )
  }
  if (rowNodes.length === 1) return rowNodes[0]
  return { type: 'split', dir: 'col', sizes: equalSizes(rowNodes.length), children: rowNodes }
}

function leafOf(id: string): LayoutSnapshot {
  return { type: 'leaf', tabs: [id], active: id }
}

function equalSizes(n: number): number[] {
  return Array.from({ length: n }, () => 1 / n)
}
