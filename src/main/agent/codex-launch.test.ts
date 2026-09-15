import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { codexReasoningEffort, prepareCodexLaunch } from './codex-launch'

const bridge = { url: 'http://127.0.0.1:12345/mcp', token: 'tok', port: 12345 }

describe('codex launch', () => {
  it('remote session isolates CODEX_HOME with a read-only MCP config', () => {
    const spec = prepareCodexLaunch('remote briefing', bridge)
    try {
      assert.ok(spec.env.CODEX_HOME)
      const toml = readFileSync(join(spec.env.CODEX_HOME, 'config.toml'), 'utf8')
      assert.match(toml, /sandbox_mode = "read-only"/)
      assert.match(toml, /shell_tool = false/)
      assert.match(toml, /\[mcp_servers\.devterm\]/)
      assert.ok(toml.includes(`Bearer ${bridge.token}`))
      assert.match(toml, /http:\/\/127\.0\.0\.1:12345\/mcp/)
      assert.ok(readFileSync(join(spec.cwd, 'AGENTS.md'), 'utf8').includes('remote briefing'))
      assert.deepEqual(spec.args.slice(0, 2), ['--sandbox', 'read-only'])
    } finally {
      spec.cleanup()
    }
  })

  it('native local uses workspace-write sandbox without planting files', () => {
    const project = mkdtempSync(join(tmpdir(), 'devterm-codex-proj-'))
    const spec = prepareCodexLaunch('must not be planted', bridge, {
      nativeLocal: true,
      spawnCwd: project
    })
    try {
      assert.equal(spec.cwd, project)
      assert.ok(spec.env.CODEX_HOME)
      assert.notEqual(spec.env.CODEX_HOME, project)
      assert.equal(existsSync(join(project, 'AGENTS.md')), false)
      const toml = readFileSync(join(spec.env.CODEX_HOME, 'config.toml'), 'utf8')
      assert.match(toml, /sandbox_mode = "workspace-write"/)
      assert.match(toml, /shell_tool = true/)
    } finally {
      spec.cleanup()
      rmSync(project, { recursive: true, force: true })
    }
  })

  it('maps model and effort flags and trims the prompt', () => {
    const spec = prepareCodexLaunch('briefing', bridge, {
      model: 'gpt-5',
      effort: 'max',
      initialPrompt: 'implement the plan   '
    })
    try {
      assert.deepEqual(spec.args.slice(0, 6), [
        '--sandbox',
        'read-only',
        '-m',
        'gpt-5',
        '-c',
        'model_reasoning_effort=xhigh'
      ])
      assert.equal(spec.args.at(-1), 'implement the plan')
      assert.equal(spec.promptDelivered, true)
    } finally {
      spec.cleanup()
    }
    assert.equal(codexReasoningEffort('low'), 'low')
    assert.equal(codexReasoningEffort('max'), 'xhigh')
    assert.equal(codexReasoningEffort('unsupported'), undefined)
  })
})
