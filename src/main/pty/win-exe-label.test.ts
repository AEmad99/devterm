import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { describe, it } from 'node:test'

const require = createRequire(import.meta.url)
const { buildResetLabelArgs, isLowIntegrityOutput } =
  require('../../../scripts/win-exe-label.cjs') as {
    buildResetLabelArgs: (target: string) => string[]
    isLowIntegrityOutput: (out: string) => boolean
  }

describe('Windows exe integrity-label hardening', () => {
  it('builds a medium-reset icacls invocation for files', () => {
    assert.deepEqual(buildResetLabelArgs('C:\\tool\\node.exe'), [
      'C:\\tool\\node.exe',
      '/setintegritylevel',
      'M'
    ])
  })

  it('detects low integrity labels in icacls output', () => {
    assert.equal(
      isLowIntegrityOutput('node.exe Mandatory Label\\Low Mandatory Level:(I)(NW)'),
      true
    )
    assert.equal(
      isLowIntegrityOutput('node.exe Mandatory Label\\Medium Mandatory Level:(I)(NW)'),
      false
    )
    assert.equal(isLowIntegrityOutput(''), false)
  })
})
