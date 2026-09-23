import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  buildMuseSettings,
  MUSE_PROMPT_ARG_LIMIT,
  museReasoningEffort,
  prepareMuseLaunch,
  resolveMuseBin
} from './muse-launch'

describe('Muse Code CLI launch', () => {
  it('resolves the Muse launcher or a platform fallback', async () => {
    const bin = await resolveMuseBin()
    assert.ok(typeof bin === 'string' && bin.length > 0)
  })

  it('creates an isolated streamable HTTP MCP settings home', async () => {
    const spec = await prepareMuseLaunch('host briefing', {
      url: 'http://127.0.0.1:12345/mcp',
      token: 'test-token',
      port: 12345
    })
    const configHome = spec.env.XDG_CONFIG_HOME
    assert.ok(configHome)
    try {
      assert.ok(existsSync(join(spec.cwd, 'AGENTS.md')))
      assert.ok(existsSync(join(configHome, 'muse', 'settings.json')))

      const settings = JSON.parse(readFileSync(join(configHome, 'muse', 'settings.json'), 'utf8'))
      assert.equal(settings.schema_version, 1)
      assert.equal(settings.mcp_servers.devterm.transport, 'streamable_http')
      assert.equal(settings.mcp_servers.devterm.url, 'http://127.0.0.1:12345/mcp')
      assert.equal(settings.mcp_servers.devterm.headers.Authorization, 'Bearer test-token')
      assert.equal(settings.mcp_servers.devterm.mode, 'required')

      assert.deepEqual(spec.args.slice(0, 3), ['--yolo', '--disable-shell', '--disable-write'])
      assert.equal(spec.promptDelivered, false)
    } finally {
      spec.cleanup()
      assert.equal(existsSync(configHome), false)
    }
  })

  it('inherits only safe Muse UI/model preferences', () => {
    const settings = buildMuseSettings(
      {
        url: 'http://127.0.0.1:12345/mcp',
        token: 'test-token',
        port: 12345
      },
      {
        provider: 'meta',
        model: 'muse-spark-1.3',
        reasoning_effort: 'max',
        tui: { theme: 'one-dark-pro' },
        permissions: { default_profile: ':unrestricted' },
        hooks: { before_tool: ['unsafe-command'] },
        mcp_servers: { personal: { command: 'other-server' } }
      }
    )

    assert.equal(settings.provider, 'meta')
    assert.equal(settings.model, 'muse-spark-1.3')
    assert.equal(settings.reasoning_effort, 'max')
    assert.deepEqual(settings.tui, { theme: 'one-dark-pro', color_depth: 'truecolor' })
    assert.equal(settings.permissions, undefined)
    assert.equal(settings.hooks, undefined)
    assert.deepEqual(Object.keys(settings.mcp_servers as object), ['devterm'])

    const echoSettings = buildMuseSettings(
      { url: 'http://127.0.0.1:12345/mcp', token: 'test-token', port: 12345 },
      { provider: 'echo', model: 'echo-model', tui: { theme: 'one-dark-pro' } }
    )
    assert.equal(echoSettings.provider, 'meta')
    assert.equal(echoSettings.model, undefined)
    assert.deepEqual(echoSettings.tui, { theme: 'one-dark-pro', color_depth: 'truecolor' })
  })

  it('forces truecolor even when the operator left color_depth on auto/16', () => {
    const settings = buildMuseSettings(
      { url: 'http://127.0.0.1:12345/mcp', token: 'test-token', port: 12345 },
      { tui: { theme: 'one-dark-pro', color_depth: '16' } }
    )
    assert.deepEqual(settings.tui, { theme: 'one-dark-pro', color_depth: 'truecolor' })

    const bare = buildMuseSettings(
      { url: 'http://127.0.0.1:12345/mcp', token: 'test-token', port: 12345 },
      {}
    )
    assert.deepEqual(bare.tui, { color_depth: 'truecolor' })
  })

  it('maps reasoning effort and keeps an interactive positional prompt', async () => {
    assert.equal(museReasoningEffort('low'), 'low')
    assert.equal(museReasoningEffort('medium'), 'medium')
    assert.equal(museReasoningEffort('high'), 'high')
    assert.equal(museReasoningEffort('max'), 'max')
    assert.equal(museReasoningEffort('ultra'), undefined)

    const spec = await prepareMuseLaunch(
      'host briefing',
      {
        url: 'http://127.0.0.1:12345/mcp',
        token: 'test-token',
        port: 12345
      },
      {
        model: 'muse-spark-1.3',
        effort: 'max',
        initialPrompt: 'implement the plan'
      }
    )
    try {
      assert.equal(spec.args[spec.args.indexOf('--model') + 1], 'muse-spark-1.3')
      assert.equal(spec.args[spec.args.indexOf('--reasoning-effort') + 1], 'max')
      assert.equal(spec.args[spec.args.length - 1], 'implement the plan')
      assert.equal(spec.promptDelivered, true)
    } finally {
      spec.cleanup()
    }
  })

  it('uses a persisted Meta model without importing unsafe global Muse settings', async () => {
    const spec = await prepareMuseLaunch(
      'host briefing',
      {
        url: 'http://127.0.0.1:12345/mcp',
        token: 'test-token',
        port: 12345
      },
      {
        preferences: {
          provider: 'meta',
          model: 'muse-spark-1.3',
          fallbackModels: [],
          resumeSessions: true,
          browserTools: true,
          agentHandoff: true,
          trustedSkills: []
        }
      }
    )
    try {
      assert.equal(spec.args[spec.args.indexOf('--model') + 1], 'muse-spark-1.3')
      const settings = JSON.parse(
        readFileSync(join(spec.env.XDG_CONFIG_HOME, 'muse', 'settings.json'), 'utf8')
      )
      assert.equal(settings.mcp_servers.devterm.headers.Authorization, 'Bearer test-token')
      assert.equal(settings.hooks, undefined)
    } finally {
      spec.cleanup()
    }
  })

  it('strips the shared provider prefix from Muse model ids', async () => {
    const spec = await prepareMuseLaunch(
      'host briefing',
      {
        url: 'http://127.0.0.1:12345/mcp',
        token: 'test-token',
        port: 12345
      },
      { model: 'meta/muse-spark-1.3' }
    )
    try {
      assert.equal(spec.args[spec.args.indexOf('--model') + 1], 'muse-spark-1.3')
    } finally {
      spec.cleanup()
    }
  })

  it('leaves oversized prompts out of argv for PTY injection fallback', async () => {
    const huge = `task ${'x'.repeat(MUSE_PROMPT_ARG_LIMIT)}`
    const spec = await prepareMuseLaunch(
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

  it('keeps native local tools while still isolating MCP settings', async () => {
    const spec = await prepareMuseLaunch(
      '',
      {
        url: 'http://127.0.0.1:12345/mcp',
        token: 'test-token',
        port: 12345
      },
      { nativeLocal: true, spawnCwd: 'operator-folder' }
    )
    const configHome = spec.env.XDG_CONFIG_HOME
    assert.ok(configHome)
    try {
      assert.equal(spec.cwd, 'operator-folder')
      assert.deepEqual(spec.args, ['--yolo'])
      assert.equal(existsSync(join(configHome, 'muse', 'settings.json')), true)
    } finally {
      spec.cleanup()
      assert.equal(existsSync(configHome), false)
    }
  })
})
