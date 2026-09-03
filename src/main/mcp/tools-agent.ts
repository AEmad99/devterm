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
 * The worker contract is deliberately Orca-style: report back exactly once
 * with `agent_message`, then stop — no supervision loop, no further spawns.
 */
export function buildAgentHandoffPrompt(input: {
  sourceKind: AgentKind
  sourceSessionId: string
  sessionId: string
  cwd: string
  kind: AgentKind
  model?: string
  effort?: AgentEffort
  /** Requested-but-not-applied model note (launcher could not honor it). */
  modelNote?: string
  prompt: string
}): string {
  const modelEffort = [input.model, input.effort].filter(Boolean).join(' / ')
  return [
    'You were opened by DevTerm to take over a task from another local agent.',
    '',
    `- Source: ${cliLabel(input.sourceKind)} (session ${input.sourceSessionId})`,
    `- Your session: ${input.sessionId}`,
    `- Working directory: ${input.cwd}`,
    `- Your CLI: ${cliLabel(input.kind)}`,
    ...(modelEffort ? [`- Model / effort: ${modelEffort}`] : []),
    ...(input.modelNote ? [`- ${input.modelNote}`] : []),
    '',
    'Do the work in this directory. Do not open another agent, do not launch',
    'agent CLIs yourself, and do not read DevTerm config or bridge files.',
    '',
    `When finished (or blocked), send ONE summary back with your \`agent_message\``,
    `tool to session ${input.sourceSessionId}, then stop and wait for the operator.`,
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
      description:
        'List local DevTerm agents in this window as JSON ' +
        '(sessionId, kind, title, cwd, bridge state; your own row has isSelf true). ' +
        'Use it to find the sessionId for agent_message.',
      inputSchema: {}
    },
    async () => text(JSON.stringify(handoff.list(), null, 2))
  )

  mcp.registerTool(
    'agent_delegate',
    {
      description:
        'Open a VISIBLE sibling tab running the requested agent CLI and hand it a complete task ' +
        'as its first message. DevTerm creates the tab, installs the bridge config, launches the ' +
        'CLI, and delivers the prompt, then returns JSON {sessionId, kind, cwd, title, ' +
        'promptDelivered, warnings} immediately (fire-and-forget: report these and stop — do NOT ' +
        'wait, poll, or re-check). kinds: devterm, pi, claude, opencode, kimi, grok, codex, ' +
        'antigravity. model is passed to the target CLI as-is, except opencode which needs ' +
        'provider/model (anything else starts the default model with a warning); omit when unsure. ' +
        'cwd defaults to your directory. NEVER launch agent CLIs yourself via the shell and NEVER ' +
        'read or write agent config files (opencode.json, .grok, CODEX_HOME, mcp.json) — just call ' +
        'this tool ONCE with a self-contained prompt. If it fails, relay the error to the operator; ' +
        'do not retry in a loop.',
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
      description:
        'Type a follow-up message into another RUNNING local agent tab (take the sessionId from ' +
        'agent_list) and submit it. Returns {ok, sessionId} once sent — the reply arrives as new ' +
        'tool activity, not as a return value, so do NOT poll after sending. If the sessionId is ' +
        'unknown, re-run agent_list instead of guessing ids.',
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
