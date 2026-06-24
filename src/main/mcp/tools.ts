import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { HostContext } from '@shared/types'
import type { SSHManager } from '../ssh/manager'
import { listRemote } from '../ssh/sftp'
import { Policy } from './policy'
import { recordBridgeActivity } from '../foundation-ipc'
import { sanitizeDetail } from './server'

/** Why a guarded action did/didn't proceed — distinct so the agent can report the real cause. */
export type ConfirmOutcome = 'approved' | 'denied' | 'timeout'

export interface ToolDeps {
  sessionId: string
  ssh: SSHManager
  context: HostContext
  airGapped: boolean
  policy: Policy
  /**
   * The operator's live remote shell cwd (from OSC 7), or undefined if unknown.
   * Tools run commands and resolve relative paths against it so the agent works
   * where the operator is `cd`'d, not in the SSH login default ($HOME).
   */
  getCwd?: () => string | undefined
  /**
   * Async cwd lookup that ALSO falls back to a one-shot `pwd` over the
   * existing SSH client when OSC 7 has never spoken for this session (sh /
   * dash login shells with no PROMPT_COMMAND hook, the very first call
   * before any prompt has rendered, or hosts where the OSC 7 setup landed in
   * tmux's stdin but never reached the inner shell). The probe is shared
   * across concurrent calls and cached. Returns undefined on Windows
   * remotes — there `pwd` is not a shell builtin and the tools use absolute
   * paths (the agent is told the cwd in its briefing).
   */
  cwdWithFallback?: () => Promise<string | undefined>
  /** Ask the operator to approve a guarded action. 'timeout' = no response in time, NOT a disconnect. */
  confirm: (tool: string, detail: string) => Promise<ConfirmOutcome>
}

// Cluster ops (helm install, oc apply + rollout, image pulls) routinely run well
// past 30s; a short default made them look like the bridge had died.
const DEFAULT_RUN_TIMEOUT_MS = 300000

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] })
const errorText = (s: string) => ({
  content: [{ type: 'text' as const, text: s }],
  isError: true
})

/**
 * The operator's live cwd, but only when it is a POSIX path (`/...`). SSH exec
 * channels always start in the login default ($HOME) and `cd` does not persist
 * between calls, so to run "where the operator is" we prefix each command with
 * a `cd` and resolve relative paths against this value. We deliberately apply
 * it only on POSIX remotes: a Windows remote cwd (`C:\...`) would build a broken
 * command for cmd.exe/PowerShell, so those hosts keep today's $HOME behaviour
 * and the agent uses absolute paths (it is still told the cwd in its briefing).
 */
function posixCwd(getCwd?: () => string | undefined): string | undefined {
  const cwd = getCwd?.()
  return cwd && cwd.startsWith('/') ? cwd : undefined
}

/**
 * Resolve the cwd for a tool call: OSC 7 first (cheap, synchronous), then the
 * async `pwd` fallback on the existing SSH client when OSC 7 is silent.
 * The fallback only fires when OSC 7 has not yet spoken, so the steady-state
 * cost is zero; the cost on a brand-new session is one bounded `pwd` exec.
 */
async function resolveCwd(
  getCwd: (() => string | undefined) | undefined,
  cwdWithFallback: (() => Promise<string | undefined>) | undefined
): Promise<string | undefined> {
  const live = posixCwd(getCwd)
  if (live) return live
  if (!cwdWithFallback) return undefined
  const probe = await cwdWithFallback()
  return probe && probe.startsWith('/') ? probe : undefined
}

/** Single-quote a path for a POSIX shell: close, escaped literal quote, reopen. */
function shQuote(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`
}

/** Resolve a possibly-relative remote path against the POSIX cwd. */
function resolvePosix(cwd: string | undefined, p: string): string {
  if (!cwd || p.startsWith('/')) return p
  return `${cwd.replace(/\/+$/, '')}/${p.replace(/^\.\//, '')}`
}

/**
 * Wrap a `confirm(...)` call so it records an `approval_request` entry at
 * request time and an `approval_outcome` entry on response. The outcome is
 * mapped to `ok` so a denial/timeout lights up the Errors filter in the
 * activity panel. The activity entries are emitted even when the bridge log
 * is the only signal we get from a guarded op (the panel and any
 * future "audit log" UI consume them uniformly).
 */
function wrapConfirm(
  sessionId: string,
  tool: string,
  detail: string,
  confirm: (tool: string, detail: string) => Promise<ConfirmOutcome>
): Promise<ConfirmOutcome> {
  recordBridgeActivity({
    sessionId,
    kind: 'approval_request',
    tool,
    detail: sanitizeDetail(detail)
  })
  return confirm(tool, detail).then((outcome) => {
    recordBridgeActivity({
      sessionId,
      kind: 'approval_outcome',
      tool,
      detail: outcome,
      // `approved` is the only "ok" outcome — denied and timeout light up the
      // Errors filter in the activity panel.
      ok: outcome === 'approved'
    })
    return outcome
  })
}

export function registerTools(mcp: McpServer, deps: ToolDeps): void {
  const { ssh, sessionId, context, airGapped, policy, confirm, getCwd, cwdWithFallback } = deps
  // Pre-bound confirm wrapper that records bridge activity around every ask.
  const confirmWithActivity = (tool: string, detail: string) =>
    wrapConfirm(sessionId, tool, detail, confirm)

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
      description:
        "Facts about the connected host: hostname, OS, the operator's current working directory, and whether it is air-gapped.",
      inputSchema: {}
    },
    async () => {
      // Probe the fallback cwd here too so a brand-new session on a host
      // whose shell never installed the OSC 7 hook (sh/dash login, or a
      // FreeBSD box) returns a real cwd on first call instead of `null`.
      const cwd = (await resolveCwd(getCwd, cwdWithFallback)) ?? null
      return text(
        JSON.stringify(
          {
            hostname: context.hostname,
            os: context.os,
            detail: context.detail,
            // The operator's live shell cwd — where run_command runs and where
            // relative file paths resolve. null until the shell reports it
            // AND a one-shot `pwd` probe can't recover it either.
            cwd,
            airGapped,
            note: airGapped
              ? 'AIR-GAPPED: no internet. Use local mirrors (Harbor/Skopeo/oc mirror), never yum/dnf/apt from the internet.'
              : 'Host has outbound internet.'
          },
          null,
          2
        )
      )
    }
  )

  mcp.registerTool(
    'run_command',
    {
      description:
        'Run a shell command on the connected remote host and return stdout/stderr/exit code. ' +
        "It runs in the operator's current terminal directory (their live `cd`); pass absolute paths to act elsewhere.",
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
      const v = await policy.evaluateCommandAsync(sessionId, command)
      if (!v.allow)
        return errorText(
          `Blocked by guardrail (policy mode: ${policy.mode}): ${v.reason}. ` +
            `The SSH/MCP connection is healthy — this is a policy block, not a disconnect. ` +
            `Ask the operator to set this host to 'confirm' or 'full' mode to run: ${command}`
        )
      if (v.needConfirm) {
        const outcome = await confirmWithActivity('run_command', command)
        if (outcome === 'timeout')
          return errorText(
            `Approval timed out — the operator did not respond to the confirmation prompt within 2 min for: ${command}. ` +
              `The connection is fine; re-issue the command to prompt again, or ask the operator to approve.`
          )
        if (outcome === 'denied') return errorText(`Operator denied: ${command}`)
      }
      try {
        const ms = timeout_ms ?? DEFAULT_RUN_TIMEOUT_MS
        // Run in the operator's live cwd. exec channels reset to $HOME on every
        // call and `cd` doesn't persist between them, so prefix one. With `&&`,
        // a missing cwd surfaces as a clear error instead of silently running in
        // the wrong directory. Policy still evaluates the agent's original
        // `command`, never our prefix. The fallback probe covers the case where
        // OSC 7 has not yet spoken (sh/dash login, brand-new session, BSD host).
        const cwd = await resolveCwd(getCwd, cwdWithFallback)
        const toRun = cwd ? `cd ${shQuote(cwd)} && ${command}` : command
        const { stdout, stderr, code, timedOut } = await ssh.exec(sessionId, toRun, ms)
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
      inputSchema: {
        path: z
          .string()
          .describe(
            "Remote directory path — absolute, or relative to the operator's current directory."
          )
      }
    },
    async ({ path }) => {
      try {
        const cwd = await resolveCwd(getCwd, cwdWithFallback)
        const target = resolvePosix(cwd, path)
        const sftp = await ssh.getSftp(sessionId)
        const listing = await listRemote(sftp, target)
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
        path: z
          .string()
          .describe(
            "Remote file path — absolute, or relative to the operator's current directory."
          ),
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
        const cwd = await resolveCwd(getCwd, cwdWithFallback)
        const target = resolvePosix(cwd, path)
        const sftp = await ssh.getSftp(sessionId)
        const buf = await new Promise<Buffer>((resolve, reject) =>
          sftp.readFile(target, (err, data) => (err ? reject(err) : resolve(data as Buffer)))
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
        path: z
          .string()
          .describe(
            "Remote file path — absolute, or relative to the operator's current directory."
          ),
        content: z.string().describe('Full file contents to write.')
      }
    },
    async ({ path, content }) => {
      const cwd = await resolveCwd(getCwd, cwdWithFallback)
      const target = resolvePosix(cwd, path)
      const v = policy.evaluateWrite()
      if (!v.allow)
        return errorText(
          `Blocked by guardrail (policy mode: ${policy.mode}): ${v.reason}. ` +
            `The SSH/MCP connection is healthy — this host's policy forbids writes. ` +
            `Ask the operator to set it to 'confirm' or 'full' mode.`
        )
      if (v.needConfirm) {
        const outcome = await confirmWithActivity(
          'write_file',
          `${target} (${content.length} bytes)`
        )
        if (outcome === 'timeout')
          return errorText(
            `Approval timed out for write to ${target} — no operator response within 2 min. ` +
              `The connection is fine; re-issue to prompt again.`
          )
        if (outcome === 'denied') return errorText(`Operator denied write to ${target}`)
      }
      try {
        const sftp = await ssh.getSftp(sessionId)
        await new Promise<void>((resolve, reject) =>
          sftp.writeFile(target, content, (err) => (err ? reject(err) : resolve()))
        )
        return text(`wrote ${content.length} bytes to ${target}`)
      } catch (e) {
        return errorText(`write_file failed: ${(e as Error).message}`)
      }
    }
  )
}
