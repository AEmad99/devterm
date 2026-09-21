import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { encodeJump, jumpLabel, listJumpHops, MAX_JUMP_HOPS } from './ssh-jump'

describe('listJumpHops', () => {
  it('reads a legacy single hop object', () => {
    const hops = listJumpHops({ host: 'bastion', port: 22, username: 'jump' })
    assert.equal(hops.length, 1)
    assert.equal(hops[0]?.host, 'bastion')
  })

  it('reads a hop list and caps at two extra hops', () => {
    const hops = listJumpHops([
      { host: 'j1', port: 22, username: 'a' },
      { host: 'j2', port: 22, username: 'b' },
      { host: 'j3', port: 22, username: 'c' }
    ])
    assert.equal(MAX_JUMP_HOPS, 2)
    assert.equal(hops.length, 2)
    assert.equal(hops[1]?.host, 'j2')
  })

  it('encodes a single hop as an object', () => {
    const encoded = encodeJump([{ host: 'bastion', port: 22, username: 'j' }])
    assert.ok(encoded && !Array.isArray(encoded))
    assert.equal(encoded.host, 'bastion')
  })

  it('labels a chain', () => {
    assert.equal(
      jumpLabel([
        { host: 'a', port: 22, username: 'u' },
        { host: 'b', port: 22, username: 'v' }
      ]),
      'u@a → v@b'
    )
  })
})
