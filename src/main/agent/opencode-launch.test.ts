import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  OPENCODE_PROMPT_ARG_LIMIT,
  prepareOpencodeLaunch,
  resolveOpencodeBin
} from './opencode-launch'

const BRIDGE = { url: 'http://127.0.0.1:12345/mcp', token: 'test-token', port: 12345 }

describe('OpenCode CLI launch', () => {
  it('resolves the opencode binary or fallback string', async () => {
    const bin = await resolveOpencodeBin()
    assert.ok(typeof bin === 'string' && bin.length > 0)
  })

  it('delivers the handoff prompt and model as TUI CLI args', async () => {
    const spec = await prepareOpencodeLaunch('host briefing', BRIDGE, {
      nativeLocal: true,
      spawnCwd: 'C:\\projects\\demo',
      model: 'anthropic/claude-sonnet-4',
      initialPrompt: 'implement the plan'
    })
    try {
      assert.equal(spec.args[0], 'C:\\projects\\demo')
      assert.equal(spec.args[spec.args.indexOf('--model') + 1], 'anthropic/claude-sonnet-4')
      assert.equal(spec.args[spec.args.indexOf('--prompt') + 1], 'implement the plan')
      assert.equal(spec.promptDelivered, true)
    } finally {
      spec.cleanup()
    }
  })

  it('leaves oversized prompts out of argv for PTY injection fallback', async () => {
    const huge = `task ${'x'.repeat(OPENCODE_PROMPT_ARG_LIMIT)}`
    assert.ok(huge.length > OPENCODE_PROMPT_ARG_LIMIT)
    const spec = await prepareOpencodeLaunch('host briefing', BRIDGE, {
      initialPrompt: huge
    })
    try {
      assert.equal(spec.args.includes('--prompt'), false)
      assert.equal(spec.promptDelivered, false)
    } finally {
      spec.cleanup()
    }
  })

  it('writes the bridge MCP config and disables built-in host tools remotely', async () => {
    const spec = await prepareOpencodeLaunch('host briefing', BRIDGE)
    try {
      const config = JSON.parse(readFileSync(join(spec.cwd, 'opencode.json'), 'utf8'))
      assert.equal(config.mcp.devterm.url, BRIDGE.url)
      assert.equal(config.mcp.devterm.headers.Authorization, `Bearer ${BRIDGE.token}`)
      for (const tool of ['bash', 'read', 'write', 'edit', 'glob', 'grep', 'question']) {
        assert.equal(config.tools[tool], false, `expected ${tool} disabled`)
      }
      assert.match(readFileSync(join(spec.cwd, 'AGENTS.md'), 'utf8'), /host briefing/)
    } finally {
      spec.cleanup()
      assert.equal(existsSync(spec.cwd), false)
    }
  })
})
