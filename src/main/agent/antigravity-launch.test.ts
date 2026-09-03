import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  ANTIGRAVITY_PROMPT_ARG_LIMIT,
  antigravityEffort,
  prepareAntigravityLaunch,
  resolveAntigravityBin
} from './antigravity-launch'

describe('Antigravity CLI launch', () => {
  it('resolves the agy binary or fallback string', async () => {
    const bin = await resolveAntigravityBin()
    assert.ok(typeof bin === 'string' && bin.length > 0)
  })

  it('prepares per-session working directory and MCP config files', async () => {
    const spec = await prepareAntigravityLaunch('host briefing', {
      url: 'http://127.0.0.1:12345/mcp',
      token: 'test-token',
      port: 12345
    })
    try {
      assert.ok(existsSync(join(spec.cwd, 'AGENTS.md')))
      assert.ok(existsSync(join(spec.cwd, '.antigravity', 'mcp.json')))
      assert.ok(existsSync(join(spec.cwd, 'mcp.json')))

      const agentsMd = readFileSync(join(spec.cwd, 'AGENTS.md'), 'utf8')
      assert.match(agentsMd, /host briefing/)

      const mcpJson = JSON.parse(readFileSync(join(spec.cwd, 'mcp.json'), 'utf8'))
      assert.equal(mcpJson.mcpServers.devterm.url, 'http://127.0.0.1:12345/mcp')
      assert.equal(mcpJson.mcpServers.devterm.headers.Authorization, 'Bearer test-token')
    } finally {
      spec.cleanup()
      assert.equal(existsSync(spec.cwd), false)
    }
  })

  it('maps DevTerm effort levels onto agy --effort', () => {
    assert.equal(antigravityEffort('low'), 'low')
    assert.equal(antigravityEffort('medium'), 'medium')
    assert.equal(antigravityEffort('high'), 'high')
    assert.equal(antigravityEffort('max'), 'high')
    assert.equal(antigravityEffort(undefined), undefined)
    assert.equal(antigravityEffort('turbo'), undefined)
  })

  it('delivers prompt positionally with model and effort for interactive start', async () => {
    const spec = await prepareAntigravityLaunch(
      'host briefing',
      {
        url: 'http://127.0.0.1:12345/mcp',
        token: 'test-token',
        port: 12345
      },
      {
        model: 'Gemini 3.5 Flash (Low)',
        effort: 'max',
        initialPrompt: 'implement the plan'
      }
    )
    try {
      assert.equal(spec.args[spec.args.indexOf('--model') + 1], 'Gemini 3.5 Flash (Low)')
      assert.equal(spec.args[spec.args.indexOf('--effort') + 1], 'high')
      // A bare positional prompt keeps the session interactive (only -p is
      // headless), so it must be the trailing arg.
      assert.equal(spec.args[spec.args.length - 1], 'implement the plan')
      assert.equal(spec.promptDelivered, true)
    } finally {
      spec.cleanup()
    }
  })

  it('leaves oversized prompts out of argv for PTY injection fallback', async () => {
    const huge = `task ${'x'.repeat(ANTIGRAVITY_PROMPT_ARG_LIMIT)}`
    const spec = await prepareAntigravityLaunch(
      'host briefing',
      {
        url: 'http://127.0.0.1:12345/mcp',
        token: 'test-token',
        port: 12345
      },
      { initialPrompt: huge }
    )
    try {
      assert.equal(spec.args.includes(huge), false)
      assert.equal(spec.promptDelivered, false)
    } finally {
      spec.cleanup()
    }
  })
})
