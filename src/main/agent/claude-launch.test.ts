import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { prepareClaudeLaunch } from './claude-launch'
import { codexReasoningEffort, prepareCodexLaunch } from './codex-launch'
import { prepareOpencodeLaunch } from './opencode-launch'

const bridge = { url: 'http://127.0.0.1:12345/mcp', token: 'tok', port: 12345 }

describe('fallback native local launches', () => {
  it('claude keeps builtins and mcp-config outside the project', async () => {
    const project = mkdtempSync(join(tmpdir(), 'devterm-claude-proj-'))
    const spec = await prepareClaudeLaunch('remote CLAUDE.md', bridge, {
      nativeLocal: true,
      spawnCwd: project,
      appendSystemPrompt: 'native local',
      model: 'claude-sonnet',
      initialPrompt: 'implement the plan'
    })
    try {
      assert.equal(spec.cwd, project)
      assert.equal(spec.args.includes('Bash'), true)
      assert.equal(spec.args.includes('mcp__devterm__*'), true)
      assert.equal(spec.args.includes('--append-system-prompt'), true)
      assert.equal(spec.args.includes('--mcp-config'), true)
      assert.equal(spec.args[spec.args.indexOf('--model') + 1], 'claude-sonnet')
      assert.equal(spec.args.at(-1), 'implement the plan')
      assert.equal(spec.promptDelivered, true)
    } finally {
      spec.cleanup()
      rmSync(project, { recursive: true, force: true })
    }
  })

  it('codex enables shell in the operator folder', () => {
    const project = mkdtempSync(join(tmpdir(), 'devterm-codex-proj-'))
    const spec = prepareCodexLaunch('remote AGENTS.md', bridge, {
      nativeLocal: true,
      spawnCwd: project
    })
    try {
      assert.equal(spec.cwd, project)
      assert.deepEqual(
        spec.args.slice(spec.args.indexOf('--sandbox'), spec.args.indexOf('--sandbox') + 2),
        ['--sandbox', 'workspace-write']
      )
      assert.match(spec.env.CODEX_HOME ?? '', /codex-home/)
    } finally {
      spec.cleanup()
      rmSync(project, { recursive: true, force: true })
    }
  })

  it('codex maps max effort and keeps invalid values out of CLI args', () => {
    const project = mkdtempSync(join(tmpdir(), 'devterm-codex-flags-'))
    const spec = prepareCodexLaunch('briefing', bridge, {
      nativeLocal: true,
      spawnCwd: project,
      model: 'luna',
      effort: 'max',
      initialPrompt: 'implement the plan'
    })
    try {
      assert.equal(spec.args[spec.args.indexOf('-m') + 1], 'luna')
      assert.equal(spec.args[spec.args.indexOf('-c') + 1], 'model_reasoning_effort=xhigh')
      assert.equal(spec.args.at(-1), 'implement the plan')
      assert.equal(spec.promptDelivered, true)
    } finally {
      spec.cleanup()
      rmSync(project, { recursive: true, force: true })
    }
  })

  it('codex omits an unsupported effort value', () => {
    assert.equal(codexReasoningEffort('unsupported'), undefined)
  })

  it('opencode keeps builtin tools and points OPENCODE_CONFIG at the overlay', async () => {
    const project = mkdtempSync(join(tmpdir(), 'devterm-oc-proj-'))
    const spec = await prepareOpencodeLaunch('remote AGENTS.md', bridge, {
      nativeLocal: true,
      spawnCwd: project,
      appendSystemPrompt: 'native local'
    })
    try {
      assert.equal(spec.cwd, project)
      assert.equal(spec.args[0], project)
      assert.ok(spec.env.OPENCODE_CONFIG)
      const cfg = JSON.parse(readFileSync(spec.env.OPENCODE_CONFIG, 'utf8')) as {
        tools?: unknown
        instructions?: unknown
      }
      assert.equal(cfg.tools, undefined)
      assert.deepEqual(cfg.instructions, ['native local'])
    } finally {
      spec.cleanup()
      rmSync(project, { recursive: true, force: true })
    }
  })
})
