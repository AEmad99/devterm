import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { placeAgentPointer, sanitizePointerEvent } from './agent-pointer'

describe('sanitizePointerEvent', () => {
  it('keeps a positioned click and drops a non-finite axis', () => {
    const ev = sanitizePointerEvent({
      tabKey: 'agt-1',
      kind: 'click',
      x: 120,
      y: 40,
      vw: 800,
      vh: 600,
      label: '  Click   now  ',
      seq: 3.9,
      direction: 'down'
    })
    assert.equal(ev?.tabKey, 'agt-1')
    assert.equal(ev?.kind, 'click')
    assert.equal(ev?.x, 120)
    assert.equal(ev?.label, 'Click now')
    assert.equal(ev?.seq, 3)
    assert.equal(ev?.direction, 'down')
  })

  it('rejects unknown kinds, empty tabs, and huge viewports', () => {
    assert.equal(sanitizePointerEvent(null), null)
    assert.equal(sanitizePointerEvent({ tabKey: '', kind: 'click' }), null)
    assert.equal(sanitizePointerEvent({ tabKey: 't', kind: 'drag' }), null)
    const ev = sanitizePointerEvent({
      tabKey: 't',
      kind: 'move',
      x: 1,
      y: Number.NaN,
      vw: 999999,
      zoom: 40
    })
    assert.equal(ev?.x, undefined)
    assert.equal(ev?.y, undefined)
    assert.equal(ev?.vw, undefined)
    assert.equal(ev?.zoom, undefined)
  })

  it('caps labels', () => {
    const ev = sanitizePointerEvent({ tabKey: 't', kind: 'type', label: 'A'.repeat(80) })
    assert.equal(ev?.label?.length, 48)
  })
})

describe('placeAgentPointer', () => {
  it('maps guest viewport fractions onto the webview box', () => {
    const placed = placeAgentPointer({
      x: 100,
      y: 50,
      vw: 200,
      vh: 100,
      zoom: 2,
      width: 800,
      height: 400
    })
    assert.equal(placed.ready, true)
    assert.equal(placed.centered, false)
    assert.equal(placed.x, 400)
    assert.equal(placed.y, 200)
    assert.equal(placed.clamped, false)
    assert.equal(placed.labelSide, 'right')
  })

  it('falls back to zoom only when the guest viewport size is missing', () => {
    const placed = placeAgentPointer({ x: 10, y: 20, zoom: 2, width: 400, height: 300 })
    assert.equal(placed.x, 20)
    assert.equal(placed.y, 40)
  })

  it('waits for a real stage size instead of pinning the cursor in the corner', () => {
    const placed = placeAgentPointer({ x: 80, y: 40, vw: 800, vh: 600, width: 0, height: 0 })
    assert.equal(placed.ready, false)
    assert.equal(placed.x, null)
    assert.equal(placed.centered, false)
  })

  it('centers when there is no point and flips the label near the right edge', () => {
    const centered = placeAgentPointer({ width: 500, height: 400 })
    assert.equal(centered.centered, true)
    assert.equal(centered.ready, true)
    const edge = placeAgentPointer({ x: 900, y: 10, vw: 1000, vh: 800, width: 500, height: 400 })
    assert.equal(edge.clamped, true)
    assert.equal(edge.labelSide, 'left')
    assert.ok((edge.x ?? 0) <= 500 - 18)
    assert.ok((edge.y ?? 0) >= 18)
  })
})
