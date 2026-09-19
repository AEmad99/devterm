import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  DEFAULT_PERSISTED_SCROLLBACK_LINES,
  MAX_PERSISTED_SCROLLBACK_LINES,
  trimSessionScrollback
} from './scrollback'

describe('session restore scrollback', () => {
  it('keeps raw ANSI and only the newest complete lines', () => {
    const raw = '\x1b[32mone\x1b[0m\n' + 'two\n' + 'three'
    assert.equal(trimSessionScrollback(raw, 2), 'two\nthree')
    assert.match(trimSessionScrollback(raw, 3), /\x1b\[32mone/)
  })

  it('uses the documented default and hard line cap', () => {
    const lines = Array.from(
      { length: DEFAULT_PERSISTED_SCROLLBACK_LINES + 5 },
      (_, i) => `${i}\n`
    ).join('')
    const defaultTail = trimSessionScrollback(lines)
    assert.equal(defaultTail.split('\n').filter(Boolean).length, DEFAULT_PERSISTED_SCROLLBACK_LINES)

    const hardCapInput = Array.from(
      { length: MAX_PERSISTED_SCROLLBACK_LINES + 1 },
      (_, i) => `${i}\n`
    ).join('')
    const hardTail = trimSessionScrollback(hardCapInput, MAX_PERSISTED_SCROLLBACK_LINES + 1)
    assert.equal(hardTail.split('\n').filter(Boolean).length, MAX_PERSISTED_SCROLLBACK_LINES)
  })

  it('bounds a single unterminated line by bytes', () => {
    const tail = trimSessionScrollback('x'.repeat(100), 10, 12)
    assert.equal(Buffer.byteLength(tail, 'utf8'), 12)
    assert.equal(tail, 'x'.repeat(12))
  })
})
