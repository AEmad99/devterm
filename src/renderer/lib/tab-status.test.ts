import { describe, it } from 'node:test'
import assert from 'node:assert'
import { deriveTabStatus } from './tab-status'

/**
 * Pure reducer for the per-tab status dot. Order of precedence matters:
 * error > pending approval > needs attention > reconnecting/bridge > running
 * > unread > idle. A closed session stays idle (no glowing after dismissal).
 */

describe('deriveTabStatus — precedence', () => {
  it('idle when nothing is set', () => {
    const s = deriveTabStatus({})
    assert.strictEqual(s.tone, 'idle')
  })

  it('error wins over pending approval', () => {
    const s = deriveTabStatus({ agentPendingApproval: true, status: 'error: handshake failed' })
    assert.strictEqual(s.tone, 'error')
  })

  it('pending approval wins over needs attention', () => {
    const s = deriveTabStatus({ agentPendingApproval: true, needsAttention: true })
    assert.strictEqual(s.tone, 'warn')
    assert.strictEqual(s.pendingApproval, true)
  })

  it('needs attention wins over running', () => {
    const s = deriveTabStatus({ needsAttention: true, processRunning: true })
    assert.strictEqual(s.tone, 'attention')
  })

  it('reconnecting shows pending (not error) when not closed', () => {
    const s = deriveTabStatus({ status: 'reconnecting' })
    assert.strictEqual(s.tone, 'pending')
  })

  it('reconnecting on a closed session is idle (no glow after dismissal)', () => {
    const s = deriveTabStatus({ status: 'reconnecting', closed: true })
    assert.strictEqual(s.tone, 'idle')
  })

  it('bridge error shows error tone', () => {
    const s = deriveTabStatus({ agentBridgeState: 'error' })
    assert.strictEqual(s.tone, 'error')
    assert.match(s.reason ?? '', /Agent bridge error/)
  })

  it('bridge starting shows pending tone', () => {
    const s = deriveTabStatus({ agentBridgeState: 'starting' })
    assert.strictEqual(s.tone, 'pending')
    assert.match(s.reason ?? '', /Starting agent bridge/)
  })

  it('running beats unread', () => {
    const s = deriveTabStatus({ processRunning: true, hasUnreadOutput: true })
    assert.strictEqual(s.tone, 'running')
  })

  it('unread is shown when nothing else is set', () => {
    const s = deriveTabStatus({ hasUnreadOutput: true })
    assert.strictEqual(s.tone, 'unread')
  })

  it('non-zero exit code is treated as error even without status', () => {
    const s = deriveTabStatus({ exitCode: 1 })
    assert.strictEqual(s.tone, 'error')
    assert.match(s.reason ?? '', /exited with code 1/)
  })

  it('zero exit code is not an error', () => {
    const s = deriveTabStatus({ exitCode: 0 })
    assert.strictEqual(s.tone, 'idle')
  })
})

describe('deriveTabStatus — status string classification', () => {
  for (const status of [
    'error: handshake failed',
    'failed: cannot connect',
    'host key mismatch',
    'reconnect failed: timed out'
  ]) {
    it(`classifies "${status}" as error`, () => {
      const s = deriveTabStatus({ status })
      assert.strictEqual(s.tone, 'error')
    })
  }

  for (const status of ['reconnecting', 'reconnecting (attempt 2/5)']) {
    it(`classifies "${status}" as pending when not closed`, () => {
      const s = deriveTabStatus({ status })
      assert.strictEqual(s.tone, 'pending')
    })
  }

  it('does not classify the literal "closed" status as error (it means the session ended cleanly)', () => {
    // A "closed" status on its own just means the session is no longer
    // active — the closed flag (or a non-zero exitCode) drives the tone.
    const s = deriveTabStatus({ status: 'closed' })
    assert.strictEqual(s.tone, 'idle')
  })

  it('does not classify "reconnected" as pending (it is the success state)', () => {
    const s = deriveTabStatus({ status: 'reconnected' })
    assert.strictEqual(s.tone, 'idle')
  })
})
