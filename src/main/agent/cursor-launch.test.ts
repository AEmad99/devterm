import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  buildCursorMcpConfig,
  CURSOR_PROMPT_ARG_LIMIT,
  prepareCursorLaunch,
  resolveCursorBin
} from './cursor-launch'

describe('Cursor Agent CLI launch', () => {
  it('resolves the Cursor launcher or a platform fallback', () => {
    const bin = resolveCursorBin()
    assert.ok(typeof bin === 'string' && bin.length > 0)
    // Prefer cursor-agent over a bare agent that may collide with other CLIs.
    assert.match(bin.toLowerCase(), /cursor-agent|agent/)
  })

  it('builds an http MCP entry with the bridge bearer', () => {
    const config = buildCursorMcpConfig({
      url: 'http://127.0.0.1:12345/mcp',
      token: 'test-token',
      port: 12345
    })
    assert.equal(config.mcpServers.devterm.type, 'http')
    assert.equal(config.mcpServers.devterm.url, 'http://127.0.0.1:12345/mcp')
    assert.equal(config.mcpServers.devterm.headers.Authorization, 'Bearer test-token')
  })

  it('creates an isolated home with yolo + approve-mcps + disabled sandbox', () => {
    const spec = prepareCursorLaunch('host briefing', {
      url: 'http://127.0.0.1:12345/mcp',
      token: 'test-token',
      port: 12345
    })
    try {
      assert.ok(existsSync(join(spec.cwd, 'AGENTS.md')))
      assert.ok(existsSync(join(spec.env.HOME, '.cursor', 'mcp.json')))
      assert.equal(spec.env.HOME, spec.env.USERPROFILE)

      const mcp = JSON.parse(readFileSync(join(spec.env.HOME, '.cursor', 'mcp.json'), 'utf8'))
      assert.equal(mcp.mcpServers.devterm.type, 'http')
      assert.equal(mcp.mcpServers.devterm.url, 'http://127.0.0.1:12345/mcp')
      assert.equal(mcp.mcpServers.devterm.headers.Authorization, 'Bearer test-token')

      assert.deepEqual(spec.args.slice(0, 4), [
        '--yolo',
        '--approve-mcps',
        '--sandbox',
        'disabled'
      ])
      assert.equal(spec.args[spec.args.indexOf('--workspace') + 1], spec.cwd)
      assert.equal(spec.promptDelivered, false)
      // Never print/headless mode.
      assert.equal(spec.args.includes('-p'), false)
      assert.equal(spec.args.includes('--print'), false)
    } finally {
      const home = spec.env.HOME
      spec.cleanup()
      assert.equal(existsSync(home), false)
    }
  })

  it('keeps native local cwd and plants a local rule briefing', () => {
    const spec = prepareCursorLaunch(
      '',
      {
        url: 'http://127.0.0.1:12345/mcp',
        token: 'test-token',
        port: 12345
      },
      {
        nativeLocal: true,
        spawnCwd: 'operator-folder',
        appendSystemPrompt: 'Use mcp__devterm__browser_open.',
        model: 'composer-2',
        initialPrompt: 'implement the plan'
      }
    )
    try {
      assert.equal(spec.cwd, 'operator-folder')
      assert.equal(existsSync(join(spec.cwd, 'AGENTS.md')), false)
      assert.ok(existsSync(join(spec.env.HOME, '.cursor', 'mcp.json')))
      assert.ok(existsSync(join(spec.env.HOME, '.cursor', 'rules', 'devterm-local.mdc')))
      assert.equal(
        readFileSync(join(spec.env.HOME, '.cursor', 'rules', 'devterm-local.mdc'), 'utf8'),
        'Use mcp__devterm__browser_open.'
      )
      assert.equal(spec.args[spec.args.indexOf('--model') + 1], 'composer-2')
      assert.equal(spec.args[spec.args.indexOf('--workspace') + 1], 'operator-folder')
      assert.equal(spec.args[spec.args.length - 1], 'implement the plan')
      assert.equal(spec.promptDelivered, true)
      assert.deepEqual(spec.args.slice(0, 4), [
        '--yolo',
        '--approve-mcps',
        '--sandbox',
        'disabled'
      ])
    } finally {
      spec.cleanup()
    }
  })

  it('leaves oversized prompts out of argv for PTY injection fallback', () => {
    const huge = `task ${'x'.repeat(CURSOR_PROMPT_ARG_LIMIT)}`
    const spec = prepareCursorLaunch(
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
