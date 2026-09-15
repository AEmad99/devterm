import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerTools } from './tools'
import { Policy } from './policy'
import { LocalHostBackend } from '../agent/host-backend'

// End-to-end over the real SDK transport pair: registration (our zod tool
// shapes) through tools/list (the SDK's zod-to-JSON-schema conversion).
// Guards the zod major line our schemas are built against.
async function listToolDefs(hostTools: boolean, browserEnabled: boolean) {
  const server = new McpServer({ name: 'devterm-test', version: '0.0.0' })
  registerTools(server, {
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
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: 'devterm-test-client', version: '0.0.0' })
  await client.connect(clientTransport)
  try {
    const { tools } = await client.listTools()
    return tools
  } finally {
    await client.close()
    await server.close()
  }
}

describe('MCP tool schemas', () => {
  it('lists host tools with converted JSON schemas', async () => {
    const tools = await listToolDefs(true, false)
    const names = tools.map((t) => t.name)
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
    const run = tools.find((t) => t.name === 'run_command')
    assert.ok(run?.inputSchema)
    const schema = run.inputSchema as { type?: string; properties?: Record<string, unknown> }
    assert.equal(schema.type, 'object')
    assert.ok(schema.properties?.command, 'run_command schema has no command property')
  })

  it('lists browser tools with converted JSON schemas', async () => {
    const tools = await listToolDefs(false, true)
    const names = tools.map((t) => t.name)
    assert.equal(
      names.some((n) => n.startsWith('browser_')),
      true
    )
    for (const tool of tools) {
      assert.equal((tool.inputSchema as { type?: string }).type, 'object', tool.name)
    }
  })
})
