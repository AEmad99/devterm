import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  parseKeyCombo,
  SYNTHETIC_FALLBACK_NOTE
} from './cdp-input'

describe('cdp-input parseKeyCombo', () => {
  it('parses bare named keys', () => {
    const r = parseKeyCombo('Enter')
    assert.ok(!('err' in r))
    if ('err' in r) return
    assert.equal(r.key, 'Enter')
    assert.equal(r.modifiers, 0)
    assert.equal(r.spec.windowsVirtualKeyCode, 13)
  })

  it('parses Control+Enter and Ctrl+A', () => {
    const enter = parseKeyCombo('Control+Enter')
    assert.ok(!('err' in enter))
    if ('err' in enter) return
    assert.equal(enter.modifiers & 2, 2)
    assert.equal(enter.key, 'Enter')

    const a = parseKeyCombo('Ctrl+A')
    assert.ok(!('err' in a))
    if ('err' in a) return
    assert.equal(a.modifiers & 2, 2)
    assert.equal(a.key, 'A')
    assert.equal(a.spec.code, 'KeyA')
  })

  it('parses Shift+Tab and Meta combos', () => {
    const tab = parseKeyCombo('Shift+Tab')
    assert.ok(!('err' in tab))
    if ('err' in tab) return
    assert.equal(tab.modifiers & 8, 8)
    assert.equal(tab.key, 'Tab')

    const meta = parseKeyCombo('Meta+s')
    assert.ok(!('err' in meta))
    if ('err' in meta) return
    assert.equal(meta.modifiers & 4, 4)
  })

  it('rejects unknown modifiers', () => {
    const r = parseKeyCombo('Foo+Enter')
    assert.ok('err' in r)
  })

  it('rejects empty input', () => {
    const r = parseKeyCombo('   ')
    assert.ok('err' in r)
  })
})

describe('cdp-input constants', () => {
  it('exports a stable synthetic-fallback tag for tool results', () => {
    assert.match(SYNTHETIC_FALLBACK_NOTE, /synthetic input fallback/)
  })
})
