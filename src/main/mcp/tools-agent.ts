import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type {
  AgentDelegateResult,
  AgentEffort,
  AgentHandoffLayout,
  AgentKind,
  AgentListEntry
} from '@shared/types'

/** Inputs accepted by the local-agent handoff MCP tools. */
export interface AgentHandoffInput {
  kind: AgentKind
  prompt: string
  model?: string
  effort?: AgentEffort
  cwd?: string
  title?: string
  layout?: AgentHandoffLayout
}

/** Main-process callbacks exposed to a local MCP bridge. */
export interface AgentHandoffDeps {
  enabled: boolean
  list: () => AgentListEntry[]
  delegate: (input: AgentHandoffInput) => Promise<AgentDelegateResult>
  message: (sessionId: string, text: string) => Promise<void>
}

const AGENT_KINDS = [
  'devterm',
  'pi',
  'claude',
  'opencode',
  'kimi',
  'grok',
  'codex',
  'antigravity'
] as const

const AGENT_EFFORTS = ['low', 'medium', 'high', 'max'] as const

const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }] })
const errorText = (value: string) => ({
  content: [{ type: 'text' as const, text: value }],
  isError: true
})

function cliLabel(kind: AgentKind): string {
  if (kind === 'devterm') return 'DevTerm Agent'
  return kind[0].toUpperCase() + kind.slice(1)
}

/**
 * Build the first message for a delegated agent. The task is appended without
 * modification so plans containing code, paths, or formatting survive intact.
 */
export function buildAgentHandoffPrompt(input: {
  sourceKind: AgentKind
  sourceSessionId: string
  cwd: string
  kind: AgentKind
  model?: string
  effort?: AgentEffort
  prompt: string
}): string {
  const modelEffort = [input.model, input.effort].filter(Boolean).join(' / ')
  return [
    'You were opened by DevTerm to take over a task from another local agent.',
    '',
    `- Source: ${cliLabel(input.sourceKind)} (session ${input.sourceSessionId})`,
    `- Working directory: ${input.cwd}`,
    `- Your CLI: ${cliLabel(input.kind)}`,
    ...(modelEffort ? [`- Model / effort: ${modelEffort}`] : []),
    '',
    'Do the work in this directory. Do not re-open another agent unless the operator asked.',
    '',
    '## Task',
    input.prompt
  ].join('\n')
}

/** Register local-only visible-agent handoff tools. */
export function registerAgentHandoffTools(
  mcp: McpServer,
  deps: { hostTools?: boolean; agentHandoff?: AgentHandoffDeps }
): void {
  // hostTools=false is the renderer's local-agent path. Never expose these
  // callbacks on a remote bridge, even if a caller accidentally supplies them.
  if (deps.hostTools !== false || !deps.agentHandoff?.enabled) return
  const handoff = deps.agentHandoff

  mcp.registerTool(
    'agent_list',
    {
      description: 'List other local DevTerm agents running in this window.',
      inputSchema: {}
    },
    async () => text(JSON.stringify(handoff.list(), null, 2))
  )

  mcp.registerTool(
    'agent_delegate',
    {
      description:
        'Open a visible sibling local DevTerm agent tab and hand it a complete task. ' +
        'This returns once the new pane has started, not when the task is finished.',
      inputSchema: {
        kind: z.enum(AGENT_KINDS),
        prompt: z.string().min(1).max(30000),
        model: z.string().trim().min(1).max(240).optional(),
        effort: z.enum(AGENT_EFFORTS).optional(),
        cwd: z.string().trim().min(1).max(4096).optional(),
        title: z.string().trim().min(1).max(120).optional(),
        layout: z.enum(['tab', 'split']).optional()
      }
    },
    async (input) => {
      try {
        const result = await handoff.delegate(input as AgentHandoffInput)
        return text(JSON.stringify(result, null, 2))
      } catch (error) {
        return errorText(
          `agent_delegate failed: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    }
  )

  mcp.registerTool(
    'agent_message',
    {
      description: 'Send a follow-up message into another running local agent terminal.',
      inputSchema: {
        sessionId: z.string().trim().min(1).max(200),
        text: z.string().min(1).max(30000)
      }
    },
    async (input) => {
      try {
        await handoff.message(input.sessionId, input.text)
        return text(JSON.stringify({ ok: true, sessionId: input.sessionId }))
      } catch (error) {
        return errorText(
          `agent_message failed: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    }
  )
}
