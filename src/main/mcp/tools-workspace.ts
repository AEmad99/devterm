import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import * as git from '../git/index'
import { globalSearchIndex } from '../search/index'
import { recordBridgeActivity } from '../ipc/foundation'
import { sanitizeDetail } from './server'
import type { ToolDeps } from './tools'

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] })
const errorText = (s: string) => ({
  content: [{ type: 'text' as const, text: s }],
  isError: true
})

const DIFF_CAP = 200000

function cwdOf(deps: ToolDeps): string | undefined {
  return deps.getCwd?.() || undefined
}

export function registerWorkspaceTools(mcp: McpServer, deps: ToolDeps): void {
  const { sessionId, host, hostDown, policy, confirm, getCwd } = deps

  const guardRead = async (tool: string, match: string) => {
    const v = await policy.evaluateCommandAsync(sessionId, match)
    if (!v.allow)
      return errorText(`Blocked by guardrail (policy mode: ${policy.mode}): ${v.reason}.`)
    if (v.needConfirm) {
      recordBridgeActivity({
        sessionId,
        kind: 'approval_request',
        tool,
        detail: sanitizeDetail(match)
      })
      const outcome = await confirm(tool, match)
      recordBridgeActivity({
        sessionId,
        kind: 'approval_outcome',
        tool,
        detail: outcome,
        ok: outcome === 'approved'
      })
      if (outcome === 'timeout') return errorText(`Approval timed out for ${tool}`)
      if (outcome === 'denied') return errorText(`Operator denied: ${match}`)
    }
    return null
  }

  mcp.registerTool(
    'git_status',
    {
      description:
        'Read-only git status for the session working tree (local folder or remote via the existing SSH exec channel). Does not commit or push.',
      inputSchema: {
        path: z.string().optional().describe('Working tree path; defaults to the operator cwd.')
      }
    },
    async ({ path }) => {
      if (host.kind === 'remote' && hostDown()) {
        return errorText('The host transport is temporarily disconnected. Retry shortly.')
      }
      const target = path?.trim() || cwdOf(deps) || '.'
      const blocked = await guardRead('git_status', `git status ${target}`)
      if (blocked) return blocked
      try {
        const status =
          host.kind === 'local'
            ? await git.gitStatusLocal(target)
            : await git.gitStatusRemote(
                async (cmd, timeoutMs) => {
                  const r = await host.exec(cmd, timeoutMs ?? 30000)
                  return { stdout: r.stdout, code: r.code }
                },
                target
              )
        return text(JSON.stringify(status, null, 2))
      } catch (e) {
        return errorText(`git_status failed: ${(e as Error).message}`)
      }
    }
  )

  mcp.registerTool(
    'git_diff',
    {
      description:
        'Read-only git diff for named files or the full working tree. Size-capped. Does not commit or push.',
      inputSchema: {
        path: z.string().optional(),
        file: z.string().optional().describe('Optional path relative to the working tree'),
        max_bytes: z.number().int().positive().optional()
      }
    },
    async ({ path, file, max_bytes }) => {
      if (host.kind === 'remote' && hostDown()) {
        return errorText('The host transport is temporarily disconnected. Retry shortly.')
      }
      const target = path?.trim() || cwdOf(deps) || '.'
      const blocked = await guardRead('git_diff', `git diff ${file ?? target}`)
      if (blocked) return blocked
      const cap = max_bytes ?? DIFF_CAP
      try {
        const diff =
          host.kind === 'local'
            ? await git.gitFullDiffLocal(target, { file })
            : await git.gitFullDiffRemote(
                (cmd, timeoutMs) => host.exec(cmd, timeoutMs ?? 30000),
                target,
                { file }
              )
        const truncated = diff.length > cap
        return text((truncated ? diff.slice(0, cap) + `\n…[truncated at ${cap} bytes]` : diff) || '(empty diff)')
      } catch (e) {
        return errorText(`git_diff failed: ${(e as Error).message}`)
      }
    }
  )

  mcp.registerTool(
    'search_terminals',
    {
      description:
        'Search recent terminal output across DevTerm sessions. Returns session id, title, line number, and snippet.',
      inputSchema: {
        query: z.string().min(1),
        limit: z.number().int().positive().optional()
      }
    },
    async ({ query, limit }) => {
      const blocked = await guardRead('search_terminals', query)
      if (blocked) return blocked
      const hits = globalSearchIndex.query(query, Math.min(limit ?? 40, 100))
      return text(
        hits.length
          ? JSON.stringify(
              hits.map((h) => ({
                sessionId: h.sessionId,
                title: h.sessionTitle,
                line: h.lineNumber,
                text: h.text
              })),
              null,
              2
            )
          : 'No matches.'
      )
    }
  )

  void getCwd
}
