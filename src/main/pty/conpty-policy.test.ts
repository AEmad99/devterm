import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { shouldUseBundledConpty } from './conpty-policy'

describe('ConPTY runtime selection', () => {
  it('uses the in-box ConPTY by default even when bundled binaries exist', () => {
    assert.equal(shouldUseBundledConpty('win32', true, undefined), false)
  })

  it('allows the bundled helper only through an explicit Windows opt-in', () => {
    assert.equal(shouldUseBundledConpty('win32', true, '1'), true)
    assert.equal(shouldUseBundledConpty('win32', false, '1'), false)
    assert.equal(shouldUseBundledConpty('linux', true, '1'), false)
  })
})
