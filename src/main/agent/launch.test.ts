import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  deriveAgentSessionId,
  deriveLocalAgentSessionId,
  getBuiltinAgentCapabilities,
  prepareBuiltinAgentLaunch,
  resolveBundledAgentCli,
  resolveBundledNodeBin,
  resolveLocalSpawnCwd
} from './launch'
import { PI_EXTENSION_SOURCE } from './extension'
import { homedir } from 'node:os'

describe('bundled DevTerm Agent launch', () => {
  it('resolves the packaged provider-agnostic CLI', () => {
    const cli = resolveBundledAgentCli()
    assert.equal(existsSync(cli), true)
    assert.match(cli.replaceAll('\\', '/'), /@earendil-works\/pi-coding-agent\/dist\/cli\.js$/)
  })

  it('discovers the offline provider/model catalog without credentials', async () => {
    const capabilities = await getBuiltinAgentCapabilities(true)
    assert.match(capabilities.runtimeVersion, /^0\.80\./)
    assert.ok(capabilities.models.length > 0)
    assert.ok(capabilities.providers.length > 0)
  })

  it('disables every ambient tool/resource discovery path', async () => {
    const spec = await prepareBuiltinAgentLaunch('host briefing', {
      url: 'http://127.0.0.1:12345/mcp',
      token: 'test-token',
      port: 12345
    })
    try {
      assert.equal(spec.args[0], resolveBundledAgentCli())
      assert.equal(spec.bin, resolveBundledNodeBin())
      assert.equal(existsSync(spec.bin), true)
      for (const flag of [
        '--no-session',
        '--no-builtin-tools',
        '--no-extensions',
        '--no-skills',
        '--no-prompt-templates',
        '--no-themes',
        '--offline'
      ]) {
        assert.equal(spec.args.includes(flag), true, `missing ${flag}`)
      }
      assert.equal(spec.args.includes('--no-tools'), false)
      assert.equal(spec.env.DEVTERM_BRIDGE_TOKEN, 'test-token')
    } finally {
      spec.cleanup()
    }
  })

  it('appends an initial prompt as the trailing CLI message', async () => {
    const spec = await prepareBuiltinAgentLaunch(
      'host briefing',
      { url: 'http://127.0.0.1:12345/mcp', token: 'test-token', port: 12345 },
      { initialPrompt: 'list files on this host' }
    )
    try {
      assert.equal(spec.args[spec.args.length - 1], 'list files on this host')
    } finally {
      spec.cleanup()
    }
  })

  it('pins provider routing and resumes a stable per-host conversation', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'devterm-agent-sessions-'))
    const skillPath = join(sessionDir, 'SKILL.md')
    const skillSource = '# Safe test skill\n'
    writeFileSync(skillPath, skillSource)
    const spec = await prepareBuiltinAgentLaunch(
      'host briefing',
      { url: 'http://127.0.0.1:12345/mcp', token: 'test-token', port: 12345 },
      {
        sessionDir,
        sessionId: 'remote-123',
        preferences: {
          provider: 'anthropic',
          model: 'anthropic/claude-sonnet-4.6',
          fallbackModels: ['openai/gpt-5', 'google/gemini-2.5-pro'],
          resumeSessions: true,
          browserTools: true,
          agentHandoff: true,
          trustedSkills: [
            {
              name: 'SKILL.md',
              path: skillPath,
              sha256: createHash('sha256').update(skillSource).digest('hex'),
              enabled: true
            }
          ]
        }
      }
    )
    try {
      assert.equal(spec.args.includes('--no-session'), false)
      assert.deepEqual(
        spec.args.slice(spec.args.indexOf('--session-dir'), spec.args.indexOf('--session-dir') + 4),
        ['--session-dir', sessionDir, '--session-id', 'remote-123']
      )
      assert.equal(spec.args[spec.args.indexOf('--provider') + 1], 'anthropic')
      assert.equal(spec.args[spec.args.indexOf('--model') + 1], 'anthropic/claude-sonnet-4.6')
      assert.equal(
        spec.args[spec.args.indexOf('--models') + 1],
        'anthropic/claude-sonnet-4.6,openai/gpt-5,google/gemini-2.5-pro'
      )
      assert.equal(spec.args[spec.args.indexOf('--skill') + 1], skillPath)
      assert.deepEqual(JSON.parse(spec.env.DEVTERM_MODEL_FALLBACKS), [
        'openai/gpt-5',
        'google/gemini-2.5-pro'
      ])
    } finally {
      spec.cleanup()
      rmSync(sessionDir, { recursive: true, force: true })
    }
  })

  it('derives stable agent session IDs for saved connections and ad-hoc hosts', () => {
    // Saved connection profile
    assert.equal(
      deriveAgentSessionId('session-999', {
        id: 'conn-prod-db-1',
        host: 'db.prod',
        port: 22,
        username: 'admin'
      }),
      'remote-conn-prod-db-1'
    )

    // Ad-hoc connection profile (no saved ID)
    assert.equal(
      deriveAgentSessionId('session-999', { host: '192.168.1.50', port: 2222, username: 'root' }),
      'remote-root-192-168-1-50-2222'
    )

    // Fallback when profile is undefined
    assert.equal(deriveAgentSessionId('session-12345-abc', undefined), 'session-12345-abc')
  })

  it('native local launch keeps builtin tools and runs in the operator folder', async () => {
    const project = mkdtempSync(join(tmpdir(), 'devterm-local-project-'))
    const spec = await prepareBuiltinAgentLaunch(
      'remote briefing must not be planted',
      { url: 'http://127.0.0.1:12345/mcp', token: 'test-token', port: 12345 },
      {
        nativeLocal: true,
        spawnCwd: project,
        approveProject: true,
        appendSystemPrompt: 'You are a native local agent.'
      }
    )
    try {
      assert.equal(spec.cwd, project)
      assert.equal(spec.args.includes('--no-builtin-tools'), false)
      assert.equal(spec.args.includes('--approve'), true)
      assert.equal(spec.args.includes('--append-system-prompt'), true)
      const promptPath = spec.args[spec.args.indexOf('--append-system-prompt') + 1]
      assert.equal(existsSync(promptPath), true)
      assert.equal(existsSync(join(project, 'AGENTS.md')), false)
      assert.equal(spec.args.includes('-e'), true)
      assert.equal(spec.env.DEVTERM_BRIDGE_TOKEN, 'test-token')
      assert.ok(spec.env.DEVTERM_MCP_DIR)
      assert.notEqual(spec.env.DEVTERM_MCP_DIR, project)
    } finally {
      spec.cleanup()
      rmSync(project, { recursive: true, force: true })
    }
  })

  it('derives per-directory local session ids', () => {
    assert.equal(deriveLocalAgentSessionId(undefined), 'local')
    assert.equal(deriveLocalAgentSessionId(''), 'local')
    const a = deriveLocalAgentSessionId('D:\\projects\\foo')
    const b = deriveLocalAgentSessionId('D:/projects/foo/')
    assert.equal(a, b)
    assert.match(a, /^local-[0-9a-f]{16}$/)
    assert.notEqual(
      deriveLocalAgentSessionId('D:\\projects\\foo'),
      deriveLocalAgentSessionId('D:\\projects\\bar')
    )
  })

  it('lists in-app browser tools in Pi Available tools via promptSnippet', () => {
    assert.match(PI_EXTENSION_SOURCE, /promptSnippet/)
    assert.match(PI_EXTENSION_SOURCE, /FIRST-CLASS DevTerm in-app browser/)
    assert.match(PI_EXTENSION_SOURCE, /Never the OS browser/)
  })

  it('resolveLocalSpawnCwd uses a real directory or home', () => {
    const dir = mkdtempSync(join(tmpdir(), 'devterm-cwd-'))
    try {
      assert.equal(resolveLocalSpawnCwd(dir), dir)
      assert.equal(resolveLocalSpawnCwd(join(dir, 'missing-subdir')), homedir())
      assert.equal(resolveLocalSpawnCwd(undefined), homedir())
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
