import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  AGENT_CURSOR_RUNTIME,
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

describe('agent cursor overlay', () => {
  it('click script glides a visible cursor then dispatches mouse events', () => {
    const s = buildClickScript('e12')
    assert.ok(s.includes('e12'))
    assert.ok(s.includes('__dt-agent-cursor'))
    assert.ok(s.includes('__dtMoveCursor'))
    assert.ok(s.includes('el.click()'))
    assert.ok(s.includes('.then('))
  })

  it('type script moves the cursor to the field before typing', () => {
    const s = buildTypeScript('e3', 'hello', false)
    assert.ok(s.includes('__dt-agent-cursor'))
    assert.ok(s.includes('__dtMoveCursor'))
    assert.ok(s.includes('hello'))
  })

  it('cursor runtime injects a pointer overlay with a pop animation', () => {
    assert.ok(AGENT_CURSOR_RUNTIME.includes('__dt-agent-cursor'))
    assert.ok(AGENT_CURSOR_RUNTIME.includes('__dt-cursor-pop'))
    assert.ok(AGENT_CURSOR_RUNTIME.includes('8b6cff'))
  })
})

describe('interact helpers', () => {
  it('resolve-ref script returns viewport coords after scrollIntoView', () => {
    const s = buildResolveRefScript('e9', { pulse: true })
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
