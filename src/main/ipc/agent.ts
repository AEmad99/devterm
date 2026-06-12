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
import { buildAgentsMd, prepareAgentLaunch } from '../agent/launch'
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
  }

  const sendBridgeStatus = (sessionId: string, status: AgentBridgeStatus) =>
    send(`${IPC.agentBridgeStatus}:${sessionId}`, status)

  ipcMain.handle(IPC.agentOpen, async (_e, opts: AgentOpenOpts): Promise<AgentOpenResult> => {
    if (sessions.has(opts.sessionId)) closeOne(opts.sessionId)
    const context = ssh.getContext(opts.sessionId)
    if (!context) throw new Error('Connect the SSH session before opening the agent.')

    const policy = new Policy(opts.mode)
    const airGapped = opts.airGapped ?? false
    const bridge = new McpBridge(
      {
        sessionId: opts.sessionId,
        ssh,
        context,
        airGapped,
        policy,
        confirm: (tool, detail) => confirm(opts.sessionId, tool, detail)
      },
      (status) => sendBridgeStatus(opts.sessionId, status)
    )
    const info = await bridge.start()

    const spec = prepareAgentLaunch(buildAgentsMd(context, airGapped), info)
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
