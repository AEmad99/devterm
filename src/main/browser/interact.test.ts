import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  buildClickScript,
  buildFillScript,
  buildHoverScript,
  buildKeyPressScript,
  buildResolveRefScript,
  buildScrollScript,
  buildSelectScript,
  buildTypeScript,
  staleRefError
} from './interact'

describe('guest interaction scripts', () => {
  it('click script dispatches mouse events and returns viewport coords', () => {
    const s = buildClickScript('e12')
    assert.ok(s.includes('e12'))
    assert.ok(s.includes('el.click()'))
    assert.ok(s.includes('getBoundingClientRect'))
    assert.equal(s.includes('__dt-agent-cursor'), false)
  })

  it('type script returns field coordinates without an in-page cursor', () => {
    const s = buildTypeScript('e3', 'hello', false)
    assert.ok(s.includes('hello'))
    assert.ok(s.includes('x:x,y:y'))
    assert.equal(s.includes('__dtMoveCursor'), false)
  })
})

describe('interact helpers', () => {
  it('resolve-ref script returns viewport coords after scrollIntoView', () => {
    const s = buildResolveRefScript('e9')
    assert.ok(s.includes('getBoundingClientRect'))
    assert.ok(s.includes('scrollIntoView'))
    assert.ok(s.includes('e9'))
  })

  it('fill prepare mode clears then focuses for CDP insertText', () => {
    const prep = buildFillScript('e1', 'hi', false, false, 'prepare')
    assert.ok(prep.includes("'prepare'"))
    assert.ok(prep.includes('el.select') || prep.includes('selectAll'))
    const full = buildFillScript('e1', 'hi', true, false, 'full')
    assert.ok(full.includes('requestSubmit') || full.includes('Enter'))
  })

  it('select script matches value/label/index on native select', () => {
    const s = buildSelectScript('e4', { label: 'Blue' })
    assert.ok(s.includes('select'))
    assert.ok(s.includes('Blue'))
    assert.ok(s.includes('selectedIndex'))
  })

  it('scroll script supports page and ref targets', () => {
    const page = buildScrollScript({ direction: 'down', pixels: 400 })
    assert.ok(page.includes('window.scrollBy'))
    const el = buildScrollScript({ ref: 'e2', direction: 'up', pixels: 100 })
    assert.ok(el.includes('e2'))
    assert.ok(el.includes('scrollBy'))
  })

  it('hover and key-with-ref scripts resolve the element first', () => {
    assert.ok(buildHoverScript('e8').includes('mouseover'))
    const key = buildKeyPressScript('Escape', 'e8')
    assert.ok(key.includes('e8'))
    assert.ok(key.includes('Escape'))
  })

  it('staleRefError tells the model to re-snapshot', () => {
    assert.match(staleRefError('e12'), /browser_snapshot/)
  })
})
