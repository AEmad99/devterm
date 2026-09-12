import { describe, it } from 'node:test'
import assert from 'node:assert'
import { computeStats, pushSample, formatRate, formatEta, type RateSample } from './transfer-stats'

describe('computeStats', () => {
  it('returns nulls with fewer than two samples', () => {
    const s = computeStats([{ t: 1000, bytes: 10 }], 100, 10)
    assert.strictEqual(s.rateBps, null)
    assert.strictEqual(s.etaSec, null)
    assert.strictEqual(s.percent, 10)
  })

  it('computes rate and ETA over the window', () => {
    const samples: RateSample[] = [
      { t: 0, bytes: 0 },
      { t: 2000, bytes: 2048 }
    ]
    const s = computeStats(samples, 8192, 2048)
    assert.strictEqual(s.rateBps, 1024)
    assert.strictEqual(s.etaSec, 6)
    assert.strictEqual(s.percent, 25)
  })

  it('returns nulls when stalled or clock-skewed', () => {
    assert.strictEqual(
      computeStats(
        [
          { t: 0, bytes: 5 },
          { t: 1000, bytes: 5 }
        ],
        10,
        5
      ).rateBps,
      null
    )
    assert.strictEqual(
      computeStats(
        [
          { t: 1000, bytes: 0 },
          { t: 0, bytes: 9 }
        ],
        10,
        9
      ).rateBps,
      null
    )
  })

  it('clamps percent and tolerates unknown totals', () => {
    assert.strictEqual(computeStats([], 0, 0).percent, 0)
    assert.strictEqual(
      computeStats(
        [
          { t: 0, bytes: 0 },
          { t: 1000, bytes: 120 }
        ],
        100,
        120
      ).percent,
      100
    )
  })
})

describe('pushSample', () => {
  it('caps the window at max samples', () => {
    const samples: RateSample[] = []
    for (let i = 0; i < 10; i++) pushSample(samples, { t: i, bytes: i }, 8)
    assert.strictEqual(samples.length, 8)
    assert.strictEqual(samples[0].t, 2)
  })

  it('coalesces same-tick samples', () => {
    const samples: RateSample[] = [{ t: 5, bytes: 5 }]
    pushSample(samples, { t: 5, bytes: 9 })
    assert.strictEqual(samples.length, 1)
    assert.strictEqual(samples[0].bytes, 9)
  })
})

describe('formatRate', () => {
  it('formats units and nulls', () => {
    assert.strictEqual(formatRate(null), '—')
    assert.strictEqual(formatRate(0), '—')
    assert.strictEqual(formatRate(840), '840 B/s')
    assert.strictEqual(formatRate(1536), '1.5 KB/s')
    assert.strictEqual(formatRate(5 * 1024 * 1024), '5.0 MB/s')
  })
})

describe('formatEta', () => {
  it('formats clock times and nulls', () => {
    assert.strictEqual(formatEta(null), '—')
    assert.strictEqual(formatEta(42), '0:42')
    assert.strictEqual(formatEta(725), '12:05')
    assert.strictEqual(formatEta(3750), '1:02:30')
  })
})
