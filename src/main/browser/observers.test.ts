import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  clearGuestObs,
  consoleTail,
  drainNotes,
  formatObsAppendix,
  lastNavFail,
  recordConsole,
  recordDownload,
  recordNavFail
} from './observers'

describe('browser observers', () => {
  it('buffers console warnings/errors and ignores debug/info', () => {
    clearGuestObs(7)
    recordConsole(7, 1, 'info noise')
    recordConsole(7, 2, 'watch out')
    recordConsole(7, 3, 'boom', 'app.js:10')
    const tail = consoleTail(7)
    assert.equal(tail.length, 2)
    assert.ok(tail[0].includes('warning: watch out'))
    assert.ok(tail[1].includes('error: boom'))
    assert.ok(tail[1].includes('app.js:10'))
  })

  it('records nav failures and download notes for draining', () => {
    clearGuestObs(9)
    recordNavFail(9, -105, 'ERR_NAME_NOT_RESOLVED', 'https://nope.test/')
    recordDownload(9, 'file.zip', 'C:\\Downloads\\file.zip')
    assert.ok(lastNavFail(9)?.includes('ERR_NAME_NOT_RESOLVED'))
    const appendix = formatObsAppendix(9, { console: true })
    assert.ok(appendix.includes('navigation failed'))
    assert.ok(appendix.includes('download started: file.zip'))
    // Drained once — second call is empty.
    assert.equal(formatObsAppendix(9), '')
    assert.deepEqual(drainNotes(9), [])
  })

  it('clears per-guest state on unregister', () => {
    clearGuestObs(3)
    recordConsole(3, 3, 'x')
    clearGuestObs(3)
    assert.equal(consoleTail(3).length, 0)
  })
})
