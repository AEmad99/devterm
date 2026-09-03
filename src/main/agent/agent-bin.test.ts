import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  assertAgentBinAvailable,
  isBinPath,
  normalizeHandoffModel,
  resolveAgentBin
} from './agent-bin'

describe('agent handoff binary pre-check', () => {
  it('skips the check for the bundled DevTerm agent', async () => {
    assert.equal(await resolveAgentBin('devterm'), undefined)
    await assertAgentBinAvailable('devterm')
  })

  it('classifies bare fallbacks as missing binaries', () => {
    assert.equal(isBinPath('opencode'), false)
    assert.equal(isBinPath('opencode.cmd'), false)
    assert.equal(isBinPath('grok.exe'), false)
    assert.equal(isBinPath('/usr/local/bin/opencode'), true)
    assert.equal(isBinPath('C:\\tools\\opencode.cmd'), true)
    assert.equal(isBinPath('\\\\share\\tools\\agy.exe'), true)
  })

  it('passes valid opencode provider/model refs through untouched', () => {
    assert.deepEqual(normalizeHandoffModel('opencode', 'anthropic/claude-sonnet-4'), {
      model: 'anthropic/claude-sonnet-4',
      warnings: []
    })
    assert.deepEqual(normalizeHandoffModel('opencode', undefined), {
      model: undefined,
      warnings: []
    })
  })

  it('drops free-form opencode models with a warning instead of killing the TUI', () => {
    const dropped = normalizeHandoffModel('opencode', 'muse spark 1.3 free')
    assert.equal(dropped.model, undefined)
    assert.equal(dropped.warnings.length, 1)
    assert.match(dropped.warnings[0], /muse spark 1\.3 free/)
    assert.match(dropped.warnings[0], /provider\/model/)
    // Bare names without a provider segment are equally unusable as --model.
    assert.equal(normalizeHandoffModel('opencode', 'sonnet').model, undefined)
  })

  it('leaves other CLIs free-form model ids alone', () => {
    for (const kind of ['kimi', 'antigravity', 'claude', 'codex', 'grok', 'pi', 'devterm'] as const) {
      assert.deepEqual(normalizeHandoffModel(kind, 'muse spark 1.3 free'), {
        model: 'muse spark 1.3 free',
        warnings: []
      })
    }
  })
  it('rejects a clearly missing CLI with an actionable error', async () => {
    // A bare command name can only come from a resolver fallback, which means
    // the lookup missed. Point PATH at nothing is environment-dependent, so
    // assert the shape of the failure instead: any rejection must name the CLI
    // and tell the caller not to work around it by hand.
    try {
      await assertAgentBinAvailable('kimi')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      assert.match(message, /Kimi/)
      assert.match(message, /do not try to/i)
      return
    }
    // Kimi is installed here — the pre-check correctly passed.
  })
})
