import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  commentKey,
  emptyBlockTracker,
  guttersToRelease,
  MAX_COMMAND_GUTTERS,
  reduceOsc133
} from './command-blocks'

describe('OSC 133 command blocks', () => {
  it('completes a block only after A then B then the next A', () => {
    let state = emptyBlockTracker()
    const a1 = reduceOsc133(state, { kind: 'A', line: 10, x: 0 })
    state = a1.state
    assert.equal(a1.completed, null)

    const b1 = reduceOsc133(state, { kind: 'B', line: 10, x: 8 })
    state = b1.state
    assert.equal(b1.completed, null)

    const a2 = reduceOsc133(state, { kind: 'A', line: 24, x: 0 })
    assert.ok(a2.completed)
    assert.equal(a2.completed?.startLine, 10)
    assert.equal(a2.completed?.inputLine, 10)
    assert.equal(a2.completed?.inputX, 8)
    assert.equal(a2.completed?.endLine, 24)
    assert.equal(a2.completed?.id, 'b1')
    assert.equal(a2.completed?.exitCode, null)
  })

  it('does not complete a prompt that never saw B', () => {
    let state = emptyBlockTracker()
    state = reduceOsc133(state, { kind: 'A', line: 1, x: 0 }).state
    const next = reduceOsc133(state, { kind: 'A', line: 4, x: 0 })
    assert.equal(next.completed, null)
  })

  it('keeps a D exit code until the next A completes the block', () => {
    let state = emptyBlockTracker()
    state = reduceOsc133(state, { kind: 'A', line: 1, x: 0 }).state
    state = reduceOsc133(state, { kind: 'B', line: 1, x: 2 }).state
    const c = reduceOsc133(state, { kind: 'C', line: 2, x: 0 })
    assert.equal(c.completed, null)
    const d = reduceOsc133(c.state, { kind: 'D', line: 8, x: 0, exitCode: 1 })
    assert.equal(d.completed, null)
    const a2 = reduceOsc133(d.state, { kind: 'A', line: 9, x: 0 })
    assert.equal(a2.completed?.exitCode, 1)
    assert.equal(a2.completed?.startLine, 1)
    assert.equal(a2.completed?.endLine, 9)
  })
})

describe('guttersToRelease', () => {
  it('keeps the newest gutters and names the ones to drop', () => {
    const items = Array.from({ length: MAX_COMMAND_GUTTERS + 3 }, (_, i) => i)
    assert.deepEqual(guttersToRelease(items), [0, 1, 2])
    assert.deepEqual(guttersToRelease([1, 2, 3], 3), [])
  })
})

describe('commentKey', () => {
  it('collapses whitespace and caps length', () => {
    assert.equal(commentKey('  git   status  '), 'git status')
    assert.equal(commentKey('x'.repeat(400)).length, 240)
  })
})
