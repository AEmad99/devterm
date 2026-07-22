import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  getBuiltinAgentCapabilities,
  prepareBuiltinAgentLaunch,
  resolveBundledAgentCli,
  resolveBundledNodeBin
} from './launch'

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
})
