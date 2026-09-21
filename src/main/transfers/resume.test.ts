import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  destPartialPath,
  mtimeSecFromMs,
  verifyPartialSize,
  verifySourceFingerprint
} from './resume'

describe('destPartialPath', () => {
  it('appends .partial to the destination path', () => {
    assert.equal(
      destPartialPath('download', 'C:\\tmp\\a.bin', '/home/a.bin'),
      'C:\\tmp\\a.bin.partial'
    )
    assert.equal(destPartialPath('upload', 'C:\\tmp\\a.bin', '/home/a.bin'), '/home/a.bin.partial')
  })

  it('does not double-suffix an existing .partial dest', () => {
    assert.equal(destPartialPath('download', '/tmp/a.partial', '/r'), '/tmp/a.partial')
  })
})

describe('verifySourceFingerprint', () => {
  it('accepts an unchanged source', () => {
    assert.equal(
      verifySourceFingerprint({ size: 10, mtimeSec: 5 }, { size: 10, mtimeSec: 5 }, 'Remote'),
      null
    )
  })

  it('rejects size or mtime drift without overwriting', () => {
    const err = verifySourceFingerprint(
      { size: 10, mtimeSec: 5 },
      { size: 11, mtimeSec: 5 },
      'Remote'
    )
    assert.match(String(err), /Remote file changed/)
    assert.match(
      String(
        verifySourceFingerprint({ size: 10, mtimeSec: 5 }, { size: 10, mtimeSec: 9 }, 'Local')
      ),
      /Local file changed/
    )
  })

  it('skips the check when no fingerprint was stored', () => {
    assert.equal(verifySourceFingerprint({}, { size: 1, mtimeSec: 1 }, 'Remote'), null)
  })
})

describe('verifyPartialSize', () => {
  it('requires the on-disk partial to match bytesDone', () => {
    assert.equal(verifyPartialSize(100, 100, 'Local partial'), null)
    assert.match(
      String(verifyPartialSize(100, 40, 'Local partial')),
      /does not match saved progress/
    )
  })
})

describe('mtimeSecFromMs', () => {
  it('floors milliseconds to whole seconds', () => {
    assert.equal(mtimeSecFromMs(1500), 1)
  })
})
