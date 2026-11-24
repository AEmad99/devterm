import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { otherOpenDoc, reconcileEditorSplit, withEditorSplit } from './editor-split'
import type { EditorSplit } from '../store/editors'

function split(
  partial: Partial<EditorSplit> & Pick<EditorSplit, 'primaryId' | 'other'>
): EditorSplit {
  return { dir: 'row', ratio: 0.5, ...partial }
}

describe('editor split', () => {
  it('keeps the ratio when the direction stays the same', () => {
    const next = withEditorSplit(
      split({ primaryId: 'a', other: 'terminal', ratio: 0.7 }),
      'row',
      'a',
      'terminal'
    )
    assert.equal(next.ratio, 0.7)
    assert.equal(next.dir, 'row')
  })

  it('resets the ratio when the direction changes', () => {
    const next = withEditorSplit(
      split({ primaryId: 'a', other: 'terminal', ratio: 0.7 }),
      'col',
      'b',
      'terminal'
    )
    assert.deepEqual(next, { dir: 'col', ratio: 0.5, primaryId: 'b', other: 'terminal' })
  })

  it('refuses to show the same file on both sides', () => {
    const next = withEditorSplit(null, 'row', 'a', 'a')
    assert.equal(next.other, 'terminal')
    assert.equal(next.primaryId, 'a')
  })

  it('picks the newest other file', () => {
    assert.equal(otherOpenDoc(['a', 'b', 'c'], 'c'), 'b')
    assert.equal(otherOpenDoc(['only'], 'only'), null)
  })

  it('drops a closed secondary file back to the terminal', () => {
    const next = reconcileEditorSplit(split({ primaryId: 'a', other: 'b' }), ['a'], 'a')
    assert.deepEqual(next, { dir: 'row', ratio: 0.5, primaryId: 'a', other: 'terminal' })
  })

  it('moves the primary pane when that file closes', () => {
    const next = reconcileEditorSplit(split({ primaryId: 'a', other: 'terminal' }), ['b'], 'b')
    assert.equal(next?.primaryId, 'b')
  })

  it('clears the split when no files remain', () => {
    assert.equal(reconcileEditorSplit(split({ primaryId: 'a', other: 'terminal' }), [], null), null)
  })

  it('leaves an unchanged split alone', () => {
    const current = split({ primaryId: 'a', other: 'terminal' })
    assert.equal(reconcileEditorSplit(current, ['a', 'b'], 'a'), current)
  })
})
