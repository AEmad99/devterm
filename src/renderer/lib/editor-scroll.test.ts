import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { noteScroll } from './editor-scroll'

describe('editor scroll memory', () => {
  it('keeps the previous offset when the scroller has no box', () => {
    const prev = { top: 480, left: 12 }
    assert.equal(noteScroll(prev, 0, 0, false), prev)
  })

  it('stores a real scroll', () => {
    assert.deepEqual(noteScroll(undefined, 200, 4, true), { top: 200, left: 4 })
  })

  it('returns the same object when nothing changed', () => {
    const prev = { top: 80, left: 0 }
    assert.equal(noteScroll(prev, 80, 0, true), prev)
  })

  it('replaces the offset after the operator scrolls', () => {
    const prev = { top: 80, left: 0 }
    assert.deepEqual(noteScroll(prev, 140, 0, true), { top: 140, left: 0 })
  })
})
