import { z } from 'zod'
import { resolve as resolveNodePath } from 'path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { HostContext } from '@shared/types'
import { looksBinary } from '../fs/content'
import { Policy } from './policy'
import { recordBridgeActivity } from '../ipc/foundation'
import { sanitizeDetail } from './server'
import { registerBrowserTools, type BrowserToolsDeps } from './tools-browser'
import type { HostBackend } from '../agent/host-backend'

/** Why a guarded action did/didn't proceed — distinct so the agent can report the real cause. */
export type ConfirmOutcome = 'approved' | 'denied' | 'timeout'

export interface ToolDeps {
  sessionId: string
  /**
   * Host operations backend: SSH channels for remote sessions, local
   * child_process/fs for local terminals. The five host tools are written
   * against this interface so a DevTerm Agent works identically on both.
   */
  host: HostBackend
  /** Live getter for the session's host context. */
  getContext: () => HostContext
  /** True while the host is disconnected or reconnecting (always false locally). */
  hostDown: () => boolean
  airGapped: boolean
  policy: Policy
  /**
   * The operator's live remote shell cwd (from OSC 7), or undefined if unknown.
   * Tools run commands and resolve relative paths against it so the agent works
   * where the operator is `cd`'d, not in the SSH login default ($HOME).
   */
  getCwd?: () => string | undefined
  /** Ask the operator to approve a guarded action. 'timeout' = no response in time, NOT a disconnect. */
  confirm: (tool: string, detail: string) => Promise<ConfirmOutcome>
  /**
   * Agent browser control (in-app browser panes). Present for every launch;
   * tools self-disable when the settings toggle is off.
   */
  browser?: BrowserToolsDeps
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
 * Wording for the "SSH is down" branch shared by every tool that touches the
 * host transport. Surfaces as a non-fatal `isError: true` result so the agent
 * pauses and retries instead of interpreting a stream of "unknown session"
 * errors as a hard failure and crashing. Wording deliberately distinguishes
 * the policy block / approval-timeout / SSH-down cases the agent used to
 * conflate.
 */
const hostDownMessage = () =>
  'The host transport is temporarily disconnected (auto-reconnect in progress). ' +
  'Retry this call shortly — the connection will come back on its own. ' +
  'Do NOT interpret this as a permanent failure or exit.'

/**
 * The operator's live cwd, applied per backend kind. Local agents run on the
 * workstation itself and get the cwd as-is (Windows `C:\...` or POSIX `/...`);
 * remote agents only get it when it is a POSIX path (`/...`). SSH exec channels
 * always start in the login default ($HOME) and `cd` does not persist between
 * calls, so for those we prefix a `cd` and resolve relative paths against this
 * value. We deliberately keep Windows-remote cwds out: a `C:\...` cwd would
 * build a broken command for cmd.exe/PowerShell on the remote, so those hosts
 * keep today's $HOME behaviour and the agent uses absolute paths (it is still
 * told the cwd in its briefing).
 */
function activeCwd(host: HostBackend, getCwd?: () => string | undefined): string | undefined {
  const cwd = getCwd?.()
  if (!cwd) return undefined
  if (host.kind === 'local') return cwd
  return cwd.startsWith('/') ? cwd : undefined
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

/** Resolve a tool target path against the operator's live cwd, per backend. */
function resolveHostPath(
  host: HostBackend,
  getCwd: (() => string | undefined) | undefined,
  p: string
): string {
  const cwd = activeCwd(host, getCwd)
  if (!cwd) return p
  if (host.kind === 'local') return resolveNodePath(cwd, p)
  return resolvePosix(cwd, p)
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
  const { host, sessionId, getContext, hostDown, airGapped, policy, confirm, getCwd } = deps
  // Pre-bound confirm wrapper that records bridge activity around every ask.
  const confirmWithActivity = (tool: string, detail: string) =>
    wrapConfirm(sessionId, tool, detail, confirm)

  mcp.registerTool(
    'ping',
    {
      description:
        'Check whether the DevTerm MCP bridge and the host session (SSH or local) are still reachable.',
      inputSchema: {}
    },
    async () => {
      const context = getContext()
      const status = hostDown()
        ? { ok: false, reason: 'Host temporarily disconnected (reconnecting). Retry shortly.' }
        : { ok: true }
      return text(
        JSON.stringify(
          {
            ...status,
            sessionId,
            hostname: context.hostname,
            policyMode: policy.mode,
            at: new Date().toISOString()
          },
          null,
          2
        )
      )
    }
  )

  mcp.registerTool(
    'get_host_context',
    {
      description:
        "Facts about the connected host: hostname, OS, the operator's current working directory, and whether it is air-gapped.",
      inputSchema: {}
    },
    async () => {
      const context = getContext()
      return text(
        JSON.stringify(
          {
            hostname: context.hostname,
            os: context.os,
            detail: context.detail,
            // The operator's live shell cwd — where run_command runs and where
            // relative file paths resolve. null until the shell reports it.
            cwd: getCwd?.() ?? null,
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
        'Run a shell command on the host (the SSH remote, or this workstation for a local agent) and return stdout/stderr/exit code. ' +
        "It runs in the operator's current terminal directory (their live `cd`); pass absolute paths to act elsewhere.",
      inputSchema: {
        command: z.string().describe('The command line to execute on the host.'),
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
      if (hostDown()) return errorText(hostDownMessage())
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
        // Run in the operator's live cwd. Local agents set child_process's
        // `cwd` so the command executes exactly where the shell prompt is;
        // remote exec channels reset to $HOME on every call, so prefix a `cd`
        // there instead. With `&&`, a missing cwd surfaces as a clear error
        // instead of silently running in the wrong directory. Policy still
        // evaluates the agent's original `command`, never our prefix.
        const cwd = activeCwd(host, getCwd)
        const local = host.kind === 'local'
        const toRun = local ? command : cwd ? `cd ${shQuote(cwd)} && ${command}` : command
        const execCwd = local ? cwd : undefined
        const { stdout, stderr, code, timedOut } = await host.exec(toRun, ms, execCwd)
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
      description: 'List a directory on the host (name, type, size, perms).',
      inputSchema: {
        path: z
          .string()
          .describe(
            "Host directory path — absolute, or relative to the operator's current directory."
          )
      }
    },
    async ({ path }) => {
      if (hostDown()) return errorText(hostDownMessage())
      try {
        const target = resolveHostPath(host, getCwd, path)
        const listing = await host.listDir(target)
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
      description: 'Read a text file from the host.',
      inputSchema: {
        path: z
          .string()
          .describe("Host file path — absolute, or relative to the operator's current directory."),
        max_bytes: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Cap bytes returned (default 200000).')
      }
    },
    async ({ path, max_bytes }) => {
      if (hostDown()) return errorText(hostDownMessage())
      try {
        const target = resolveHostPath(host, getCwd, path)
        const cap = max_bytes ?? 200000
        // The backend reads at most `cap + 1` bytes (SFTP handle locally /
        // bounded read on disk) so a 2 GB log never crosses the wire whole;
        // the extra byte reports truncation.
        const { data: buf, truncated } = await host.readFile(target, cap)
        // Guard against binary files: decoding arbitrary bytes as UTF-8 emits
        // U+FFFD noise which the agent then prints into its terminal — the
        // "random gibberish" symptom. Force file transfers for binary content.
        if (looksBinary(buf)) {
          return errorText(
            `read_file failed: ${target} appears to be a binary file ` +
              `(detected by NUL/non-text bytes in the first scan window). ` +
              `Use an SFTP download instead of read_file for binary content.`
          )
        }
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
      description: 'Write/overwrite a text file on the host.',
      inputSchema: {
        path: z
          .string()
          .describe("Host file path — absolute, or relative to the operator's current directory."),
        content: z.string().describe('Full file contents to write.')
      }
    },
    async ({ path, content }) => {
      if (hostDown()) return errorText(hostDownMessage())
      const target = resolveHostPath(host, getCwd, path)
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
          `${target} (${Buffer.byteLength(content, 'utf8')} bytes)`
        )
        if (outcome === 'timeout')
          return errorText(
            `Approval timed out for write to ${target} — no operator response within 2 min. ` +
              `The connection is fine; re-issue to prompt again.`
          )
        if (outcome === 'denied') return errorText(`Operator denied write to ${target}`)
      }
      try {
        await host.writeFile(target, content)
        return text(`wrote ${Buffer.byteLength(content, 'utf8')} bytes to ${target}`)
      } catch (e) {
        return errorText(`write_file failed: ${(e as Error).message}`)
      }
    }
  )

  registerBrowserTools(mcp, deps)
}
