import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerTools } from './tools'
import { Policy } from './policy'
import { LocalHostBackend } from '../agent/host-backend'

function collectTools(hostTools: boolean, browserEnabled: boolean): string[] {
  const names: string[] = []
  const mcp = {
    registerTool: (name: string) => {
      names.push(name)
    }
  } as unknown as McpServer
  registerTools(mcp, {
    sessionId: 's1',
    host: new LocalHostBackend(),
    getContext: () => ({ kind: 'local', os: 'windows', hostname: 'h', detail: '' }),
    hostDown: () => false,
    airGapped: false,
    policy: new Policy('full'),
    confirm: async () => 'approved',
    hostTools,
    browser: { enabled: browserEnabled, service: {} as never }
  })
  return names
}

describe('MCP tool registration', () => {
  it('registers host tools for remote sessions', () => {
    const names = collectTools(true, false)
    for (const tool of [
      'ping',
      'get_host_context',
      'run_command',
      'list_dir',
      'read_file',
      'write_file'
    ]) {
      assert.equal(names.includes(tool), true, `missing ${tool}`)
    }
    assert.equal(
      names.some((n) => n.startsWith('browser_')),
      false
    )
  })

  it('skips host tools locally and keeps browser tools when enabled', () => {
    const names = collectTools(false, true)
    for (const tool of [
      'ping',
      'get_host_context',
      'run_command',
      'list_dir',
      'read_file',
      'write_file'
    ]) {
      assert.equal(names.includes(tool), false, `unexpected host tool ${tool}`)
    }
    assert.equal(
      names.some((n) => n.startsWith('browser_')),
      true
    )
  })
})
