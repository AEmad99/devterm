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
        confirm: (tool, detail) => confirm(opts.sessionId, tool, detail)
      },
      (status) => sendBridgeStatus(opts.sessionId, status)
    )
    const info = await bridge.start()

    const spec =
      opts.kind === 'claude'
        ? prepareClaudeLaunch(buildClaudeMd(context, airGapped, cwds.get(opts.sessionId)), info)
        : opts.kind === 'opencode'
          ? prepareOpencodeLaunch(
              buildOpencodeMd(context, airGapped, cwds.get(opts.sessionId)),
              info
            )
          : prepareAgentLaunch(buildAgentsMd(context, airGapped, cwds.get(opts.sessionId)), info)
    const { id: ptyId } = pty.create({
      shell: spec.bin,
      args: spec.args,
      cwd: spec.cwd,
      env: spec.env,
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
