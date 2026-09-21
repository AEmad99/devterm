import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  matchPerformancePreset,
  normalizeSearchIndexLines,
  PERFORMANCE_PRESETS
} from './performance-presets'

describe('performance presets', () => {
  it('recognizes the balanced default', () => {
    assert.equal(matchPerformancePreset(PERFORMANCE_PRESETS.balanced.values), 'balanced')
  })

  it('recognizes low-memory and full-fidelity', () => {
    assert.equal(matchPerformancePreset(PERFORMANCE_PRESETS['low-memory'].values), 'low-memory')
    assert.equal(
      matchPerformancePreset(PERFORMANCE_PRESETS['full-fidelity'].values),
      'full-fidelity'
    )
  })

  it('returns custom when a knob diverges', () => {
    assert.equal(
      matchPerformancePreset({
        ...PERFORMANCE_PRESETS.balanced.values,
        hibernateAfterMs: 12_000
      }),
      'custom'
    )
  })

  it('clamps search index lines', () => {
    assert.equal(normalizeSearchIndexLines(50), 200)
    assert.equal(normalizeSearchIndexLines(50_000), 10_000)
    assert.equal(normalizeSearchIndexLines('nope'), 2000)
  })
})
