import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { HostContext } from '@shared/types'
import type { SSHManager } from '../ssh/manager'
import { listRemote } from '../ssh/sftp'
import { Policy } from './policy'

/** Why a guarded action did/didn't proceed — distinct so the agent can report the real cause. */
export type ConfirmOutcome = 'approved' | 'denied' | 'timeout'

export interface ToolDeps {
  sessionId: string
  ssh: SSHManager
  context: HostContext
  airGapped: boolean
  policy: Policy
  /** Ask the operator to approve a guarded action. 'timeout' = no response in time, NOT a disconnect. */
  confirm: (tool: string, detail: string) => Promise<ConfirmOutcome>
}

// Cluster ops (helm install, oc apply + rollout, image pulls) routinely run well
// past 30s; a short default made them look like the bridge had died.
const DEFAULT_RUN_TIMEOUT_MS = 300000

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] })
const errorText = (s: string) => ({ content: [{ type: 'text' as const, text: s }], isError: true })

export function registerTools(mcp: McpServer, deps: ToolDeps): void {
  const { ssh, sessionId, context, airGapped, policy, confirm } = deps

  mcp.registerTool(
    'ping',
    {
      description:
        'Check whether the DevTerm MCP bridge and remote SSH session are still reachable.',
      inputSchema: {}
    },
    async () =>
      text(
        JSON.stringify(
          {
            ok: true,
            sessionId,
            hostname: context.hostname,
            policyMode: policy.mode,
            at: new Date().toISOString()
          },
          null,
          2
        )
      )
  )

  mcp.registerTool(
    'get_host_context',
    {
      description: 'Facts about the connected host: hostname, OS, and whether it is air-gapped.',
      inputSchema: {}
    },
    async () =>
      text(
        JSON.stringify(
          {
            hostname: context.hostname,
            os: context.os,
            detail: context.detail,
            airGapped,
            note: airGapped
              ? 'AIR-GAPPED: no internet. Use local mirrors (Harbor/Skopeo/oc mirror), never yum/dnf/apt from the internet.'
              : 'Host has outbound internet.'
          },
          null,
          2
        )
      )
  )

  mcp.registerTool(
    'run_command',
    {
      description:
        'Run a shell command on the connected remote host and return stdout/stderr/exit code.',
      inputSchema: {
        command: z.string().describe('The command line to execute on the remote host.'),
        timeout_ms: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            'Timeout in ms (default 300000 = 5 min). The command keeps running on the host past this — raise it for long cluster ops rather than assuming a failure.'
          )
      }
    },
    async ({ command, timeout_ms }) => {
      const v = policy.evaluateCommand(command)
      if (!v.allow)
        return errorText(
          `Blocked by guardrail (policy mode: ${policy.mode}): ${v.reason}. ` +
            `The SSH/MCP connection is healthy — this is a policy block, not a disconnect. ` +
            `Ask the operator to set this host to 'confirm' or 'full' mode to run: ${command}`
        )
      if (v.needConfirm) {
        const outcome = await confirm('run_command', command)
        if (outcome === 'timeout')
          return errorText(
            `Approval timed out — the operator did not respond to the confirmation prompt within 2 min for: ${command}. ` +
              `The connection is fine; re-issue the command to prompt again, or ask the operator to approve.`
          )
        if (outcome === 'denied') return errorText(`Operator denied: ${command}`)
      }
      try {
        const ms = timeout_ms ?? DEFAULT_RUN_TIMEOUT_MS
        const { stdout, stderr, code, timedOut } = await ssh.exec(sessionId, command, ms)
        // A timeout is reported as a normal (non-error) result with explicit wording:
        // marking it isError historically led the agent to misreport it as a dropped connection.
        if (timedOut)
          return text(
            `TIMEOUT after ${ms}ms — the command is STILL RUNNING on the host and was NOT cancelled; ` +
              `the SSH/MCP connection is healthy. Re-run with a larger timeout_ms to wait longer, or check ` +
              `progress with a follow-up command.` +
              `${stdout ? `\n--- partial stdout ---\n${stdout}` : ''}${stderr ? `\n--- partial stderr ---\n${stderr}` : ''}`
          )
        return text(
          `exit_code: ${code}\n--- stdout ---\n${stdout}${stderr ? `\n--- stderr ---\n${stderr}` : ''}`
        )
      } catch (e) {
        return errorText(`run_command failed: ${(e as Error).message}`)
      }
    }
  )

  mcp.registerTool(
    'list_dir',
    {
      description: 'List a directory on the remote host (name, type, size, perms).',
      inputSchema: { path: z.string().describe('Absolute remote directory path.') }
    },
    async ({ path }) => {
      try {
        const sftp = await ssh.getSftp(sessionId)
        const listing = await listRemote(sftp, path)
        const lines = listing.entries.map(
          (e) => `${e.mode} ${String(e.size).padStart(10)} ${e.name}${e.isDir ? '/' : ''}`
        )
        return text(`${listing.path}\n${lines.join('\n')}`)
      } catch (e) {
        return errorText(`list_dir failed: ${(e as Error).message}`)
      }
    }
  )

  mcp.registerTool(
    'read_file',
    {
      description: 'Read a text file from the remote host.',
      inputSchema: {
        path: z.string().describe('Absolute remote file path.'),
        max_bytes: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Cap bytes returned (default 200000).')
      }
    },
    async ({ path, max_bytes }) => {
      try {
        const sftp = await ssh.getSftp(sessionId)
        const buf = await new Promise<Buffer>((resolve, reject) =>
          sftp.readFile(path, (err, data) => (err ? reject(err) : resolve(data as Buffer)))
        )
        const cap = max_bytes ?? 200000
        const truncated = buf.length > cap
        return text(
          buf.subarray(0, cap).toString('utf8') +
            (truncated ? `\n…[truncated at ${cap} bytes]` : '')
        )
      } catch (e) {
        return errorText(`read_file failed: ${(e as Error).message}`)
      }
    }
  )

  mcp.registerTool(
    'write_file',
    {
      description: 'Write/overwrite a text file on the remote host.',
      inputSchema: {
        path: z.string().describe('Absolute remote file path.'),
        content: z.string().describe('Full file contents to write.')
      }
    },
    async ({ path, content }) => {
      const v = policy.evaluateWrite()
      if (!v.allow)
        return errorText(
          `Blocked by guardrail (policy mode: ${policy.mode}): ${v.reason}. ` +
            `The SSH/MCP connection is healthy — this host's policy forbids writes. ` +
            `Ask the operator to set it to 'confirm' or 'full' mode.`
        )
      if (v.needConfirm) {
        const outcome = await confirm('write_file', `${path} (${content.length} bytes)`)
        if (outcome === 'timeout')
          return errorText(
            `Approval timed out for write to ${path} — no operator response within 2 min. ` +
              `The connection is fine; re-issue to prompt again.`
          )
        if (outcome === 'denied') return errorText(`Operator denied write to ${path}`)
      }
      try {
        const sftp = await ssh.getSftp(sessionId)
        await new Promise<void>((resolve, reject) =>
          sftp.writeFile(path, content, (err) => (err ? reject(err) : resolve()))
        )
        return text(`wrote ${content.length} bytes to ${path}`)
      } catch (e) {
        return errorText(`write_file failed: ${(e as Error).message}`)
      }
    }
  )
}
