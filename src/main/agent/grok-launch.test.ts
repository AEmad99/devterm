import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { prepareGrokLaunch } from './grok-launch'

const bridge = { url: 'http://127.0.0.1:12345/mcp', token: 'tok', port: 12345 }

describe('grok launch', () => {
  it('remote session loads MCP from overlay cwd .grok/config.toml', () => {
    const spec = prepareGrokLaunch('remote briefing', bridge)
    try {
      assert.equal(spec.env.GROK_HOME, undefined)
      const toml = readFileSync(join(spec.cwd, '.grok', 'config.toml'), 'utf8')
      assert.match(toml, /mcp_servers\.devterm/)
      assert.match(toml, /Bearer tok/)
      assert.ok(readFileSync(join(spec.cwd, 'AGENTS.md'), 'utf8').includes('remote briefing'))
    } finally {
      spec.cleanup()
    }
  })

  it('native local keeps project cwd and puts MCP under isolated GROK_HOME', () => {
    const project = mkdtempSync(join(tmpdir(), 'devterm-grok-proj-'))
    const spec = prepareGrokLaunch('remote briefing must not be planted', bridge, {
      nativeLocal: true,
      spawnCwd: project,
      appendSystemPrompt: 'Use devterm__browser_open.'
    })
    try {
      assert.equal(spec.cwd, project)
      assert.ok(spec.env.GROK_HOME)
      assert.notEqual(spec.env.GROK_HOME, project)
      const toml = readFileSync(join(spec.env.GROK_HOME, 'config.toml'), 'utf8')
      assert.match(toml, /mcp_servers\.devterm/)
      assert.match(toml, /http:\/\/127\.0\.0\.1:12345\/mcp/)
      const rule = readFileSync(join(spec.env.GROK_HOME, 'rules', 'devterm-local.md'), 'utf8')
      assert.match(rule, /devterm__browser_open/)
    } finally {
      spec.cleanup()
      rmSync(project, { recursive: true, force: true })
    }
  })

  it('passes supported model, effort, and prompt flags but omits invalid effort', () => {
    const valid = prepareGrokLaunch('briefing', bridge, {
      model: 'luna',
      effort: 'max',
      initialPrompt: 'implement the plan   '
    })
    try {
      assert.deepEqual(valid.args.slice(-5), [
        '--model',
        'luna',
        '--effort',
        'max',
        'implement the plan'
      ])
    } finally {
      valid.cleanup()
    }

    const invalid = prepareGrokLaunch('briefing', bridge, {
      effort: 'unsupported' as never,
      initialPrompt: 'task'
    })
    try {
      assert.equal(invalid.args.includes('--effort'), false)
      assert.equal(invalid.args.at(-1), 'task')
    } finally {
      invalid.cleanup()
    }
  })
})
