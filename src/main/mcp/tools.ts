import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { HostContext } from '@shared/types'
import type { SSHManager } from '../ssh/manager'
import { listRemote } from '../ssh/sftp'
import { Policy } from './policy'

export interface ToolDeps {
  sessionId: string
  ssh: SSHManager
  context: HostContext
  airGapped: boolean
  policy: Policy
  /** Ask the operator to approve a guarded action; resolves true if approved. */
  confirm: (tool: string, detail: string) => Promise<boolean>
}

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] })
const errorText = (s: string) => ({ content: [{ type: 'text' as const, text: s }], isError: true })

export function registerTools(mcp: McpServer, deps: ToolDeps): void {
  const { ssh, sessionId, context, airGapped, policy, confirm } = deps

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
      description: 'Run a shell command on the connected remote host and return stdout/stderr/exit code.',
      inputSchema: {
        command: z.string().describe('The command line to execute on the remote host.'),
        timeout_ms: z.number().int().positive().optional().describe('Timeout in ms (default 30000).')
      }
    },
    async ({ command, timeout_ms }) => {
      const v = policy.evaluateCommand(command)
      if (!v.allow) return errorText(`Blocked by guardrail (${policy.mode}): ${v.reason}. Command: ${command}`)
      if (v.needConfirm && !(await confirm('run_command', command)))
        return errorText(`Operator denied: ${command}`)
      try {
        const { stdout, stderr, code } = await ssh.exec(sessionId, command, timeout_ms ?? 30000)
        return text(`exit_code: ${code}\n--- stdout ---\n${stdout}${stderr ? `\n--- stderr ---\n${stderr}` : ''}`)
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
        max_bytes: z.number().int().positive().optional().describe('Cap bytes returned (default 200000).')
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
        return text(buf.subarray(0, cap).toString('utf8') + (truncated ? `\n…[truncated at ${cap} bytes]` : ''))
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
      if (!v.allow) return errorText(`Blocked by guardrail (${policy.mode}): ${v.reason}.`)
      if (v.needConfirm && !(await confirm('write_file', `${path} (${content.length} bytes)`)))
        return errorText(`Operator denied write to ${path}`)
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
