// Keep in sync with src/renderer/lib/grid.ts — PR1 reviewers must diff logic against grid.ts.
// Pure-JS runtime harness for grid snapshot math; no test runner or TS required.

const GRID_MAX_ROWS = 4
const GRID_MAX_COLS = 4
const GRID_MAX_CELLS = 16
const GRID_MIN_DIM = 1

function clampGridSpec(spec) {
  const rows = Math.min(GRID_MAX_ROWS, Math.max(GRID_MIN_DIM, Math.floor(spec.rows)))
  const cols = Math.min(GRID_MAX_COLS, Math.max(GRID_MIN_DIM, Math.floor(spec.cols)))
  return { rows, cols }
}

function validateGridSpec(spec) {
  if (!Number.isFinite(spec.rows) || !Number.isFinite(spec.cols)) return 'Invalid dimensions'
  if (spec.rows < GRID_MIN_DIM || spec.cols < GRID_MIN_DIM) return 'Minimum is 1×1'
  if (spec.rows > GRID_MAX_ROWS || spec.cols > GRID_MAX_COLS) {
    return `Maximum is ${GRID_MAX_ROWS}×${GRID_MAX_COLS}`
  }
  if (spec.rows * spec.cols > GRID_MAX_CELLS) return `Maximum ${GRID_MAX_CELLS} terminals`
  return null
}

function leafOf(id) {
  return { type: 'leaf', tabs: [id], active: id }
}

function equalSizes(n) {
  return Array.from({ length: n }, () => 1 / n)
}

function buildGridSnapshot(ids, rows, cols) {
  const expected = rows * cols
  if (ids.length !== expected) {
    throw new Error(
      `buildGridSnapshot: expected ${expected} ids (rows=${rows} cols=${cols}), got ${ids.length}`
    )
  }
  if (rows === 1 && cols === 1) return leafOf(ids[0])
  if (rows === 1) {
    return { type: 'split', dir: 'row', sizes: equalSizes(cols), children: ids.map(leafOf) }
  }
  if (cols === 1) {
    return { type: 'split', dir: 'col', sizes: equalSizes(rows), children: ids.map(leafOf) }
  }
  const rowNodes = []
  for (let r = 0; r < rows; r++) {
    const slice = ids.slice(r * cols, r * cols + cols)
    rowNodes.push({
      type: 'split',
      dir: 'row',
      sizes: equalSizes(cols),
      children: slice.map(leafOf)
    })
  }
  return { type: 'split', dir: 'col', sizes: equalSizes(rows), children: rowNodes }
}

function packIdsAsGrid(ids, preferredCols) {
  if (!ids.length) return null
  const cols = Math.min(preferredCols, GRID_MAX_COLS, ids.length)
  const rows = Math.ceil(ids.length / cols)
  const rowNodes = []
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

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERT FAILED: ${message}`)
}

function approx(a, b, eps = 1e-12) {
  return Math.abs(a - b) <= eps
}

function sumSizes(node) {
  if (node.type === 'leaf') return 0
  return node.sizes.reduce((a, b) => a + b, 0)
}

function countLeaves(node) {
  if (node.type === 'leaf') return 1
  return node.children.reduce((acc, c) => acc + countLeaves(c), 0)
}

function idsInOrder(node, out = []) {
  if (node.type === 'leaf') {
    out.push(...node.tabs)
    return out
  }
  for (const c of node.children) idsInOrder(c, out)
  return out
}

function run() {
  // 1x1
  const a = buildGridSnapshot(['a'], 1, 1)
  assert(a.type === 'leaf' && a.tabs[0] === 'a', '1x1 is a single leaf')

  // 1x4
  const b = buildGridSnapshot(['a', 'b', 'c', 'd'], 1, 4)
  assert(b.type === 'split' && b.dir === 'row', '1x4 is a row split')
  assert(b.children.length === 4, '1x4 has 4 children')
  assert(approx(sumSizes(b), 1), '1x4 sizes sum to 1')
  assert(countLeaves(b) === 4, '1x4 has 4 leaves')

  // 4x1
  const c = buildGridSnapshot(['a', 'b', 'c', 'd'], 4, 1)
  assert(c.type === 'split' && c.dir === 'col', '4x1 is a column split')
  assert(c.children.length === 4, '4x1 has 4 children')

  // 2x2
  const d = buildGridSnapshot(['a', 'b', 'c', 'd'], 2, 2)
  assert(d.type === 'split' && d.dir === 'col', '2x2 outer is col')
  assert(d.children.length === 2, '2x2 outer has 2 row children')
  assert(
    d.children.every((r) => r.type === 'split' && r.dir === 'row'),
    '2x2 rows are row splits'
  )
  assert(approx(sumSizes(d), 1), '2x2 outer sizes sum to 1')
  assert(
    d.children.every((r) => approx(sumSizes(r), 1)),
    '2x2 row sizes sum to 1'
  )
  assert(idsInOrder(d).join('') === 'abcd', '2x2 ids are row-major')

  // 3x2
  const e = buildGridSnapshot(['a', 'b', 'c', 'd', 'e', 'f'], 3, 2)
  assert(e.type === 'split' && e.dir === 'col', '3x2 outer is col')
  assert(e.children.length === 3, '3x2 outer has 3 row children')
  assert(
    e.children.every((r) => r.children.length === 2),
    '3x2 rows have 2 cells'
  )
  assert(idsInOrder(e).join('') === 'abcdef', '3x2 ids are row-major')

  // 4x4 max
  const ids16 = Array.from({ length: 16 }, (_, i) => `s${i}`)
  const f = buildGridSnapshot(ids16, 4, 4)
  assert(countLeaves(f) === 16, '4x4 has 16 leaves')

  // length mismatch throws
  let threw = false
  try {
    buildGridSnapshot(['a', 'b'], 2, 2)
  } catch {
    threw = true
  }
  assert(threw, 'length mismatch throws')

  // packIdsAsGrid
  const g = packIdsAsGrid(['a', 'b', 'c', 'd'], 3)
  assert(g.type === 'split' && g.dir === 'col', 'pack 4 in 3 cols outer is col')
  assert(countLeaves(g) === 4, 'pack keeps all 4 ids')

  const h = packIdsAsGrid(['a', 'b', 'c'], 3)
  assert(h.type === 'split' && h.dir === 'row', 'pack 3 in 3 cols is a single row')

  const i = packIdsAsGrid(['a'], 3)
  assert(i.type === 'leaf' && i.tabs[0] === 'a', 'pack 1 is a leaf')

  assert(packIdsAsGrid([], 2) === null, 'pack empty returns null')

  // validateGridSpec
  assert(validateGridSpec({ rows: 2, cols: 2 }) === null, '2x2 valid')
  assert(validateGridSpec({ rows: 0, cols: 2 }) !== null, '0 rows invalid')
  assert(validateGridSpec({ rows: 5, cols: 2 }) !== null, '5 rows invalid')
  assert(validateGridSpec({ rows: 4, cols: 5 }) !== null, '5 cols invalid')
  assert(validateGridSpec({ rows: 4, cols: 4 }) === null, '4x4 valid')
  assert(validateGridSpec({ rows: 5, cols: 5 }) !== null, '5x5 invalid')

  console.log('✓ grid snapshot assertions passed')
}

run()
