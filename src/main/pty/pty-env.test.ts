import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildPtyBaseEnv } from './manager'

describe('buildPtyBaseEnv', () => {
  it('advertises truecolor and drops parent no-color signals', () => {
    const env = buildPtyBaseEnv({
      PATH: '/bin',
      NO_COLOR: '1',
      FORCE_COLOR: '0',
      COLORTERM: 'mono',
      ELECTRON_RUN_AS_NODE: '1',
      NODE_OPTIONS: '--no-warnings',
      VITE_DEV_SERVER_URL: 'http://127.0.0.1:5173'
    })
    assert.equal(env.PATH, '/bin')
    assert.equal(env.COLORTERM, 'truecolor')
    assert.equal(env.NO_COLOR, undefined)
    assert.equal(env.FORCE_COLOR, undefined)
    assert.equal(env.ELECTRON_RUN_AS_NODE, undefined)
    assert.equal(env.NODE_OPTIONS, undefined)
    assert.equal(env.VITE_DEV_SERVER_URL, undefined)
  })

  it('keeps a non-zero FORCE_COLOR from the parent', () => {
    const env = buildPtyBaseEnv({ FORCE_COLOR: '3', HOME: '/home/op' })
    assert.equal(env.FORCE_COLOR, '3')
    assert.equal(env.HOME, '/home/op')
    assert.equal(env.COLORTERM, 'truecolor')
  })
})
