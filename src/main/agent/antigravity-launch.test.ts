import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { prepareAntigravityLaunch, resolveAntigravityBin } from './antigravity-launch'

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
})
