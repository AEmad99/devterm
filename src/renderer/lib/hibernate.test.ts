import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { canHibernateSession } from './hibernate'

describe('terminal hibernate guards', () => {
  it('allows an inactive clean terminal after the delay', () => {
    assert.equal(
      canHibernateSession({ kind: 'local', groupId: 'background' }, 'active', false),
      true
    )
  })

  it('does not hibernate a hidden terminal that needs attention', () => {
    assert.equal(
      canHibernateSession(
        { kind: 'remote', groupId: 'background', needsAttention: true },
        'active',
        false
      ),
      false
    )
  })

  it('does not hibernate a dirty editor or a browser pane', () => {
    assert.equal(
      canHibernateSession({ kind: 'local', groupId: 'background' }, 'active', true),
      false
    )
    assert.equal(
      canHibernateSession({ kind: 'browser', groupId: 'background' }, 'active', false),
      false
    )
  })
})
