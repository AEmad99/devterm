import { describe, it } from 'node:test'
import assert from 'node:assert'
import { matchRules } from './approval-rules'
import type { ApprovalRule } from '@shared/types'

/**
 * Pure unit tests for the longest-prefix + token-boundary match used by
 * `approvalRules.match`. We test `matchRules` (no file IO) so the test
 * doesn't need to import the Electron `app` module.
 */

const rule = (overrides: Partial<ApprovalRule> & { commandPrefix: string }): ApprovalRule => ({
  id: overrides.id ?? overrides.commandPrefix,
  commandPrefix: overrides.commandPrefix,
  outcome: overrides.outcome ?? 'allow',
  sessionId: overrides.sessionId,
  createdAt: overrides.createdAt ?? 0
})

describe('approval-rules matchRules — token boundary', () => {
  it('matches the prefix as the entire command', () => {
    const r = rule({ commandPrefix: 'kubectl' })
    assert.ok(matchRules([r], 's', 'kubectl'))
  })

  it('matches the prefix followed by space (typical case)', () => {
    const r = rule({ commandPrefix: 'kubectl' })
    assert.ok(matchRules([r], 's', 'kubectl get pods'))
  })

  it('matches the prefix followed by tab/newline/pipe/amp/semicolon', () => {
    const r = rule({ commandPrefix: 'ls' })
    for (const cmd of ['ls\t-la', 'ls\n-la', 'ls | grep x', 'ls && echo ok', 'ls; echo ok']) {
      assert.ok(matchRules([r], 's', cmd), `should match: ${cmd}`)
    }
  })

  it('matches the prefix followed by redirect or paren', () => {
    const r = rule({ commandPrefix: 'echo' })
    assert.ok(matchRules([r], 's', 'echo hi > out'))
    assert.ok(matchRules([r], 's', 'echo hi < in'))
    assert.ok(matchRules([r], 's', 'echo(hi'))
  })

  it('does NOT match a longer word containing the prefix (kubectl vs kubectlized)', () => {
    const r = rule({ commandPrefix: 'kubectl' })
    assert.strictEqual(matchRules([r], 's', 'kubectlized get pods'), undefined)
  })

  it('does NOT match when prefix is not a prefix of the command', () => {
    const r = rule({ commandPrefix: 'kubectl' })
    assert.strictEqual(matchRules([r], 's', 'docker ps'), undefined)
  })

  it('trims leading whitespace before matching', () => {
    const r = rule({ commandPrefix: 'kubectl' })
    assert.ok(matchRules([r], 's', '   kubectl get pods'))
  })

  it('returns undefined for an empty command', () => {
    const r = rule({ commandPrefix: 'kubectl' })
    assert.strictEqual(matchRules([r], 's', ''), undefined)
    assert.strictEqual(matchRules([r], 's', '   '), undefined)
  })
})

describe('approval-rules matchRules — specificity', () => {
  it('longer prefix wins over a shorter prefix', () => {
    const a = rule({ commandPrefix: 'kubectl', outcome: 'allow' })
    const b = rule({ commandPrefix: 'kubectl delete', outcome: 'deny' })
    const m = matchRules([a, b], 's', 'kubectl delete pod x')
    assert.ok(m)
    assert.strictEqual(m.outcome, 'deny')
  })

  it('shorter prefix is used when the longer one does not match', () => {
    const a = rule({ commandPrefix: 'kubectl', outcome: 'allow' })
    const b = rule({ commandPrefix: 'kubectl delete', outcome: 'deny' })
    const m = matchRules([a, b], 's', 'kubectl get pods')
    assert.ok(m)
    assert.strictEqual(m.outcome, 'allow')
  })

  it('a longer global rule beats a shorter session-specific rule', () => {
    const longerGlobal = rule({ commandPrefix: 'kubectl delete', outcome: 'deny' })
    const shorterSession = rule({ commandPrefix: 'kubectl', outcome: 'allow', sessionId: 's1' })
    const m = matchRules([longerGlobal, shorterSession], 's1', 'kubectl delete pod x')
    assert.ok(m)
    assert.strictEqual(m.outcome, 'deny')
  })

  it('a same-length session-specific rule beats a global rule', () => {
    const globalRule = rule({ commandPrefix: 'kubectl', outcome: 'allow' })
    const sessionRule = rule({ commandPrefix: 'kubectl', outcome: 'deny', sessionId: 's1' })
    const m = matchRules([globalRule, sessionRule], 's1', 'kubectl get pods')
    assert.ok(m)
    assert.strictEqual(m.outcome, 'deny')
  })
})

describe('approval-rules matchRules — session scoping', () => {
  it('a session-specific rule only matches its session', () => {
    const r = rule({ commandPrefix: 'kubectl', sessionId: 's1' })
    assert.ok(matchRules([r], 's1', 'kubectl get pods'))
    assert.strictEqual(matchRules([r], 's2', 'kubectl get pods'), undefined)
  })

  it('a global rule matches any session', () => {
    const r = rule({ commandPrefix: 'kubectl' })
    assert.ok(matchRules([r], 's1', 'kubectl get pods'))
    assert.ok(matchRules([r], 's2', 'kubectl get pods'))
  })

  it('global rule is chosen for a different session when no session-specific match exists', () => {
    const sessionRule = rule({ commandPrefix: 'kubectl', sessionId: 's1', outcome: 'deny' })
    const globalRule = rule({ commandPrefix: 'kubectl', outcome: 'allow' })
    const m = matchRules([sessionRule, globalRule], 's2', 'kubectl get pods')
    assert.ok(m)
    assert.strictEqual(m.outcome, 'allow')
  })
})
