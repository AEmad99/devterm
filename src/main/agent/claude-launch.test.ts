import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { prepareClaudeLaunch } from './claude-launch'
import { prepareCodexLaunch } from './codex-launch'
import { prepareOpencodeLaunch } from './opencode-launch'

const bridge = { url: 'http://127.0.0.1:12345/mcp', token: 'tok', port: 12345 }

describe('fallback native local launches', () => {
  it('claude keeps builtins and mcp-config outside the project', async () => {
    const project = mkdtempSync(join(tmpdir(), 'devterm-claude-proj-'))
    const spec = await prepareClaudeLaunch('remote CLAUDE.md', bridge, {
      nativeLocal: true,
      spawnCwd: project,
      appendSystemPrompt: 'native local'
    })
    try {
      assert.equal(spec.cwd, project)
      assert.equal(spec.args.includes('Bash'), true)
      assert.equal(spec.args.includes('mcp__devterm__*'), true)
      assert.equal(spec.args.includes('--append-system-prompt'), true)
      assert.equal(spec.args.includes('--mcp-config'), true)
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
        instructions?: string
      }
      assert.equal(cfg.tools, undefined)
      assert.equal(cfg.instructions, 'native local')
    } finally {
      spec.cleanup()
      rmSync(project, { recursive: true, force: true })
    }
  })
})
