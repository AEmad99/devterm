import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  buildAgentHandoffPrompt,
  registerAgentHandoffTools,
  type AgentHandoffInput
} from './tools-agent'

describe('local agent handoff tools', () => {
  it('wraps the source metadata while preserving the raw task', () => {
    const task = 'Implement these files:\n- src/main/ipc/agent.ts\nKeep the task intact.'
    const prompt = buildAgentHandoffPrompt({
      sourceKind: 'grok',
      sourceSessionId: 'local-source-1',
      cwd: 'D:\\projects\\DevTerm',
      kind: 'codex',
      model: 'luna',
      effort: 'max',
      prompt: task
    })
    assert.match(prompt, /Source: Grok \(session local-source-1\)/)
    assert.match(prompt, /Working directory: D:\\projects\\DevTerm/)
    assert.match(prompt, /Your CLI: Codex/)
    assert.match(prompt, /Model \/ effort: luna \/ max/)
    assert.ok(prompt.endsWith(task))
  })

  it('returns a structured error when the delegate cap rejects a request', async () => {
    type Result = { isError?: boolean; content: Array<{ text?: string }> }
    type Handler = (input: AgentHandoffInput) => Promise<Result>
    const handlers = new Map<string, Handler>()
    const mcp = {
      registerTool: (name: string, _config: unknown, handler: Handler) => {
        handlers.set(name, handler)
      }
    } as unknown as McpServer
    registerAgentHandoffTools(mcp, {
      hostTools: false,
      agentHandoff: {
        enabled: true,
        list: () => [],
        delegate: async () => {
          throw new Error('Delegate cap reached')
        },
        message: async () => undefined
      }
    })
    const result = await handlers.get('agent_delegate')!({ kind: 'codex', prompt: 'work' })
    assert.equal(result.isError, true)
    assert.match(result.content[0]?.text ?? '', /Delegate cap reached/)
  })
})
