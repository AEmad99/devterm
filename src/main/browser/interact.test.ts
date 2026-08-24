import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { AGENT_CURSOR_RUNTIME, buildClickScript, buildTypeScript } from './interact'

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
