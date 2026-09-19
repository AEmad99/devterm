import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { shouldHideToTrayOnClose } from './window-lifecycle'

describe('tray-resident window lifecycle', () => {
  it('hides instead of closing when enabled for a normal user close', () => {
    assert.equal(
      shouldHideToTrayOnClose({
        keepSessionsInTray: true,
        allowWindowClose: false,
        selfTest: false
      }),
      true
    )
  })

  it('keeps explicit Quit on the destructive close path', () => {
    assert.equal(
      shouldHideToTrayOnClose({
        keepSessionsInTray: true,
        allowWindowClose: true,
        selfTest: false
      }),
      false
    )
  })

  it('never hides the self-test window', () => {
    assert.equal(
      shouldHideToTrayOnClose({
        keepSessionsInTray: true,
        allowWindowClose: false,
        selfTest: true
      }),
      false
    )
  })
})
