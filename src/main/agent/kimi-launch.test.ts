import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { prepareKimiLaunch, resolveKimiBin } from './kimi-launch'

const BRIDGE = { url: 'http://127.0.0.1:12345/mcp', token: 'test-token', port: 12345 }

describe('Kimi CLI launch', () => {
  it('resolves the kimi binary or fallback string', async () => {
    const bin = await resolveKimiBin()
    assert.ok(typeof bin === 'string' && bin.length > 0)
  })

  it('passes a requested model via --model and keeps the TUI interactive', async () => {
    const spec = await prepareKimiLaunch('host briefing', BRIDGE, {
      model: 'kimi-k2',
      initialPrompt: 'implement the plan'
    })
    try {
      assert.equal(spec.args[spec.args.indexOf('--model') + 1], 'kimi-k2')
      // `-p` would switch to non-interactive print mode: the handoff prompt
      // must travel via PTY injection, never as a CLI prompt flag.
      assert.equal(spec.args.includes('-p'), false)
      assert.equal(spec.args.includes('--prompt'), false)
      assert.equal(spec.promptDelivered ?? false, false)
    } finally {
      spec.cleanup()
    }
  })

  it('omits model flags when no model is requested', async () => {
    const spec = await prepareKimiLaunch('host briefing', BRIDGE)
    try {
      assert.equal(spec.args.includes('--model'), false)
    } finally {
      spec.cleanup()
    }
  })
})
