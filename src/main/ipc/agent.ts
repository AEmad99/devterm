import { ipcMain, BrowserWindow } from 'electron'
import { randomUUID } from 'crypto'
import {
  IPC,
  type AgentBridgeStatus,
  type AgentOpenOpts,
  type AgentOpenResult,
  type ConfirmRequest
} from '@shared/types'
import { McpBridge } from '../mcp/server'
import type { ConfirmOutcome } from '../mcp/tools'
import { Policy } from '../mcp/policy'
import { envForAgent } from '../provider-keys'
import * as approvalRules from '../approval-rules'
import { buildAgentsMd, prepareAgentLaunch } from '../agent/launch'
import { buildClaudeMd, prepareClaudeLaunch } from '../agent/claude-launch'
import { buildOpencodeMd, prepareOpencodeLaunch } from '../agent/opencode-launch'
import type { SSHManager } from '../ssh/manager'
import type { PtyManager } from '../pty/manager'

interface AgentSession {
  bridge: McpBridge
  ptyId: string
  cleanup: () => void
  /** Last-known cwd from the operator's shell (OSC 7) or a `pwd` fallback. */
  cwdFallback?: string
  /** In-flight `pwd` probe so concurrent tool calls share one exec. */
  cwdProbe?: Promise<string | undefined>
}

export interface AgentController {
  closeAll: () => void
}

export function registerAgentIpc(
  ssh: SSHManager,
  pty: PtyManager,
  getWindow: () => BrowserWindow | null
): AgentController {
  const sessions = new Map<string, AgentSession>()
  const pendingConfirms = new Map<string, (outcome: ConfirmOutcome) => void>()
  // The remote shell's live cwd per session, fed by OSC 7 from the renderer
  // (`agent:set-cwd`). The bridge reads it through a getter so the agent's
  // commands follow the operator's `cd` without restarting the agent.
  const cwds = new Map<string, string>()
  /**
   * Last-resort cwd when OSC 7 has never spoken for this session. This happens
   * on `sh`/`dash` login shells (no PROMPT_COMMAND hook), on hosts where the
   * remote OSC 7 setup landed in tmux's stdin but never reached the inner
   * shell, and on the very first call before any prompt has rendered. We
   * probe with a one-shot `pwd` over the existing SSH client (no second
   * connection) and cache the answer. The probe is shared across concurrent
   * tool calls so a flood of read_file calls only runs one `pwd`.
   */
  async function pwdFallback(sessionId: string): Promise<string | undefined> {
    const sess = sessions.get(sessionId)
    if (!sess) return undefined
    if (sess.cwdFallback) return sess.cwdFallback
    if (sess.cwdProbe) return sess.cwdProbe
    sess.cwdProbe = (async () => {
      try {
        const ctx = ssh.getContext(sessionId)
        // Skip the probe on Windows hosts: `pwd` is a POSIX command and the
        // Windows branch of `posixCwd` (see mcp/tools.ts) deliberately returns
        // undefined so the agent uses absolute paths — same fallback path.
        if (!ctx || ctx.os === 'windows') return undefined
        const { stdout, code } = await ssh.exec(sessionId, 'pwd', 5000)
        const out = stdout.trim()
        if (code === 0 && out) {
          sess!.cwdFallback = out
          // Mirror into the renderer-visible cwds map so get_host_context
          // returns it without needing a second probe.
          cwds.set(sessionId, out)
          return out
        }
        return undefined
      } catch {
        return undefined
      } finally {
        sess.cwdProbe = undefined
      }
    })()
    return sess.cwdProbe
  }

  /**
   * Getter the bridge calls on every tool invocation. Returns the live OSC 7
   * cwd if known, otherwise kicks off (and awaits) a one-shot `pwd` probe.
   * The probe is bounded — a dead SSH returns undefined fast and the tool
   * falls back to absolute-path semantics, the same as a Windows host.
   */
  const getCwdWithFallback = async (sessionId: string): Promise<string | undefined> => {
    const known = cwds.get(sessionId)
    if (known) return known
    return pwdFallback(sessionId)
  }

  const send = (channel: string, ...args: unknown[]) => {
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
  }

  // Ask the renderer to approve a guarded action (confirm mode / destructive op).
  // Resolves 'timeout' if the operator never answers — distinct from an explicit
  // 'denied' so the tool can tell the agent the connection is still healthy.
  const confirm = (sessionId: string, tool: string, detail: string): Promise<ConfirmOutcome> =>
    new Promise((resolve) => {
      const reqId = randomUUID()
      pendingConfirms.set(reqId, resolve)
      const req: ConfirmRequest = { reqId, sessionId, tool, detail }
      send(IPC.agentConfirm, req)
      setTimeout(() => {
        if (pendingConfirms.delete(reqId)) resolve('timeout')
      }, 120000)
    })

  ipcMain.on(IPC.agentConfirmReply, (_e, reqId: string, approved: boolean) => {
    const r = pendingConfirms.get(reqId)
    if (r) {
      pendingConfirms.delete(reqId)
      r(approved ? 'approved' : 'denied')
    }
  })

  const closeOne = (sessionId: string) => {
    const s = sessions.get(sessionId)
    if (!s) return
    pty.kill(s.ptyId)
    void s.bridge.stop()
    s.cleanup()
    sessions.delete(sessionId)
    cwds.delete(sessionId)
  }

  // Live cwd updates from the renderer's OSC 7 tracking. Fire-and-forget: a
  // stray update before the agent is open is harmless (the next open seeds from
  // opts.cwd and the renderer re-pushes), so we just record the latest value.
  ipcMain.on(IPC.agentSetCwd, (_e, sessionId: string, cwd: string) => {
    if (typeof cwd === 'string' && cwd) cwds.set(sessionId, cwd)
  })

  const sendBridgeStatus = (sessionId: string, status: AgentBridgeStatus) =>
    send(`${IPC.agentBridgeStatus}:${sessionId}`, status)

  ipcMain.handle(IPC.agentOpen, async (_e, opts: AgentOpenOpts): Promise<AgentOpenResult> => {
    if (sessions.has(opts.sessionId)) closeOne(opts.sessionId)
    const context = ssh.getContext(opts.sessionId)
    if (!context) throw new Error('Connect the SSH session before opening the agent.')

    // Seed the live cwd from the launch snapshot; `agent:set-cwd` refines it as
    // the operator navigates. The bridge reads it lazily via getCwd below.
    if (opts.cwd) cwds.set(opts.sessionId, opts.cwd)

    const policy = new Policy(opts.mode, (sessionId, command) =>
      approvalRules.match(sessionId, command).then((r) => (r ? { outcome: r.outcome } : undefined))
    )
    const airGapped = opts.airGapped ?? false
    const bridge = new McpBridge(
      {
        sessionId: opts.sessionId,
        ssh,
        context,
        airGapped,
        policy,
        getCwd: () => cwds.get(opts.sessionId),
        cwdWithFallback: () => getCwdWithFallback(opts.sessionId),
        confirm: (tool, detail) => confirm(opts.sessionId, tool, detail)
      },
      (status) => sendBridgeStatus(opts.sessionId, status)
    )
    const info = await bridge.start()

    // For the briefing file we accept either an OSC 7 value or a one-shot
    // `pwd` probe — gives the agent a concrete path to start from instead of
    // the "not reported yet" placeholder on hosts where OSC 7 hasn't spoken
    // yet (sh/dash login, brand-new session, BSD).
    const initialCwd = cwds.get(opts.sessionId) ?? (await pwdFallback(opts.sessionId))

    const spec =
      opts.kind === 'claude'
        ? prepareClaudeLaunch(buildClaudeMd(context, airGapped, initialCwd), info)
        : opts.kind === 'opencode'
          ? prepareOpencodeLaunch(buildOpencodeMd(context, airGapped, initialCwd), info)
          : prepareAgentLaunch(buildAgentsMd(context, airGapped, initialCwd), info)
    // Inject provider API keys from the encrypted store. Done here (not in
    // the launch specs) so the launch layer stays sync and the keys are
    // resolved fresh on every agent:open — that's what makes a key
    // rotation in Settings take effect on the next agent start.
    const providerEnv = await envForAgent()

    const { id: ptyId } = pty.create({
      shell: spec.bin,
      args: spec.args,
      cwd: spec.cwd,
      env: { ...spec.env, ...providerEnv },
      cols: opts.cols,
      rows: opts.rows
    })

    sessions.set(opts.sessionId, { bridge, ptyId, cleanup: spec.cleanup })
    return { ptyId, mcpUrl: info.url }
  })

  ipcMain.handle(IPC.agentStatus, (_e, sessionId: string): AgentBridgeStatus | null => {
    return sessions.get(sessionId)?.bridge.getStatus() ?? null
  })

  ipcMain.on(IPC.agentClose, (_e, sessionId: string) => closeOne(sessionId))

  return {
    closeAll: () => {
      for (const id of [...sessions.keys()]) closeOne(id)
    }
  }
}
