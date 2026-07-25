import { ipcMain, BrowserWindow, app, dialog, type OpenDialogOptions } from 'electron'
import { createHash, randomUUID } from 'crypto'
import { mkdirSync, readFileSync, statSync } from 'fs'
import { basename, join } from 'path'
import {
  IPC,
  type AgentBridgeStatus,
  type AgentOpenOpts,
  type AgentOpenResult,
  type AgentTrustedSkill,
  type ConfirmRequest,
  type HostContext,
  type SSHStatus
} from '@shared/types'
import { McpBridge } from '../mcp/server'
import type { ConfirmOutcome } from '../mcp/tools'
import { Policy } from '../mcp/policy'
import * as approvalRules from '../agent/approval-rules'
import {
  buildAgentsMd,
  deriveAgentSessionId,
  getBuiltinAgentCapabilities,
  prepareAgentLaunch,
  prepareBuiltinAgentLaunch,
  sweepStaleAgentTempDirs
} from '../agent/launch'
import { buildClaudeMd, prepareClaudeLaunch } from '../agent/claude-launch'
import { buildKimiMd, prepareKimiLaunch } from '../agent/kimi-launch'
import { buildOpencodeMd, prepareOpencodeLaunch } from '../agent/opencode-launch'
import { buildGrokMd, prepareGrokLaunch } from '../agent/grok-launch'
import { buildCodexMd, prepareCodexLaunch } from '../agent/codex-launch'
import { buildAntigravityMd, prepareAntigravityLaunch } from '../agent/antigravity-launch'
import type { SSHManager } from '../ssh/manager'
import type { PtyManager } from '../pty/manager'

interface AgentSession {
  bridge: McpBridge
  ptyId: string
  cleanup: () => void
  /** True between SSH `closed` and `reconnected`. Tools return a clear retry-msg. */
  sshDown: boolean
  /** Host context at bridge start; falls back when SSH is briefly between states. */
  lastContext: HostContext
  /** Disposers for the SSH status + PTY exit subscriptions. */
  sshDispose?: () => void
  ptyDispose?: () => void
  /** Set when the agent PTY exits; drives auto-restart on SSH reconnect. */
  agentExited: boolean
  /** Last launch opts (for the auto-restart-after-reconnect path). */
  lastOpts?: AgentOpenOpts
  /** Last bridge status emitted; reused for `sshDown` mirror so the UI sees it. */
  lastBridgeStatus?: AgentBridgeStatus
}

export interface AgentController {
  /**
   * Tear down every active agent session (kill PTYs, stop bridges, remove
   * temp dirs). Returns a promise that resolves once all bridges have
   * actually closed; callers may fire-and-forget if they don't need to
   * wait for the async bridge shutdown to finish.
   */
  closeAll: () => Promise<void>
}

export function registerAgentIpc(
  ssh: SSHManager,
  pty: PtyManager,
  getWindow: () => BrowserWindow | null
): AgentController {
  // Crash-path backstop: per-session temp dirs hold the bridge bearer token
  // (and codex sessions a copy of ~/.codex/auth.json); explicit close removes
  // them, a crash doesn't. Sweep day-old leftovers once at startup.
  sweepStaleAgentTempDirs()

  const sessions = new Map<string, AgentSession>()
  interface PendingConfirm {
    sessionId: string
    resolve: (outcome: ConfirmOutcome) => void
    timer: ReturnType<typeof setTimeout>
  }
  const pendingConfirms = new Map<string, PendingConfirm>()
  // Per-session launch chain: serializes agent:open against the reconnect
  // auto-restart so a concurrent pair never runs two launchAgent calls (the
  // loser would leak a bridge port, heartbeat interval, and temp dir).
  const launchChains = new Map<string, Promise<unknown>>()
  const enqueueLaunch = <T>(sessionId: string, fn: () => Promise<T>): Promise<T> => {
    const prev = launchChains.get(sessionId) ?? Promise.resolve()
    const next = prev.catch(() => undefined).then(fn)
    launchChains.set(
      sessionId,
      next.then(
        () => undefined,
        () => undefined
      )
    )
    return next
  }
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
      const timer = setTimeout(() => {
        if (pendingConfirms.delete(reqId)) resolve('timeout')
      }, 120000)
      pendingConfirms.set(reqId, { sessionId, resolve, timer })
      const req: ConfirmRequest = { reqId, sessionId, tool, detail }
      send(IPC.agentConfirm, req)
    })

  ipcMain.on(IPC.agentConfirmReply, (_e, reqId: string, approved: boolean) => {
    const r = pendingConfirms.get(reqId)
    if (r) {
      pendingConfirms.delete(reqId)
      clearTimeout(r.timer)
      r.resolve(approved ? 'approved' : 'denied')
    }
  })

  const closeOne = async (sessionId: string): Promise<void> => {
    const s = sessions.get(sessionId)
    if (!s) return
    // Fail any in-flight approval prompts for this session immediately —
    // otherwise the tool call pends until the 120s timeout after the pane is
    // already gone.
    for (const [reqId, pending] of pendingConfirms) {
      if (pending.sessionId !== sessionId) continue
      pendingConfirms.delete(reqId)
      clearTimeout(pending.timer)
      pending.resolve('denied')
    }
    s.sshDispose?.()
    s.ptyDispose?.()
    s.sshDispose = undefined
    s.ptyDispose = undefined
    try {
      pty.kill(s.ptyId)
    } catch {
      /* already gone */
    }
    // Await the bridge stop before removing the temp dir: the bridge's async
    // shutdown may still touch files in the temp dir, and `cleanup()` deletes
    // it with rmSync. Killing the agent + awaiting the bridge tear-down is
    // also what keeps orphaned ports / heartbeat intervals from accumulating
    // across retries.
    try {
      await s.bridge.stop()
    } catch {
      /* bridge may already be stopped */
    }
    try {
      s.cleanup()
    } catch {
      /* temp dir already gone */
    }
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
    // Serialize against reconnect auto-restart for the same session id.
    return enqueueLaunch(opts.sessionId, async () => {
      // Close any previous session for the same id (Restart button path). Await
      // so the old bridge / temp dir are fully gone before we allocate new ones.
      if (sessions.has(opts.sessionId)) await closeOne(opts.sessionId)
      return launchAgent(opts)
    })
  })

  ipcMain.handle(IPC.agentCapabilities, (_e, forceRefresh: boolean) =>
    getBuiltinAgentCapabilities(forceRefresh === true)
  )

  ipcMain.handle(IPC.agentChooseSkill, async (): Promise<AgentTrustedSkill | null> => {
    const options: OpenDialogOptions = {
      title: 'Choose an instruction-only agent skill',
      properties: ['openFile'],
      filters: [
        { name: 'Skill markdown', extensions: ['md'] },
        { name: 'All files', extensions: ['*'] }
      ]
    }
    const win = getWindow()
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths[0]) return null
    const path = result.filePaths[0]
    const stat = statSync(path)
    if (!stat.isFile() || stat.size > 512 * 1024) {
      throw new Error('Skills must be regular files no larger than 512 KiB.')
    }
    const sha256 = createHash('sha256').update(readFileSync(path)).digest('hex')
    return { name: basename(path), path, sha256, enabled: true }
  })

  /**
   * Spin up the MCP bridge + agent PTY for the given session. Factored out of
   * the `agent:open` IPC handler so the auto-restart-after-SSH-reconnect path
   * can call it with the saved launch opts. All resource allocation that can
   * fail (bridge.start, pty spawn) sits inside a try/catch that tears down
   * everything already allocated — partial failure used to orphan an HTTP
   * server + heartbeat interval + temp dir per retry.
   */
  const launchAgent = async (
    opts: AgentOpenOpts,
    reusePtyId?: string
  ): Promise<AgentOpenResult> => {
    const context = ssh.getContext(opts.sessionId)
    if (!context) throw new Error('Connect the SSH session before opening the agent.')

    if (opts.cwd) cwds.set(opts.sessionId, opts.cwd)

    const policy = new Policy(opts.mode, (sessionId, command) =>
      approvalRules.match(sessionId, command).then((r) => (r ? { outcome: r.outcome } : undefined))
    )
    const airGapped = opts.airGapped ?? false
    const bridge = new McpBridge(
      {
        sessionId: opts.sessionId,
        ssh,
        getContext: () => ssh.getContext(opts.sessionId) ?? context,
        sshDown: () => sessions.get(opts.sessionId)?.sshDown ?? false,
        airGapped,
        policy,
        getCwd: () => cwds.get(opts.sessionId),
        confirm: (tool, detail) => confirm(opts.sessionId, tool, detail)
      },
      (status) => {
        // Cache the latest status so the SSH status listener can mirror a
        // paused/connected state without re-deriving it.
        const sess = sessions.get(opts.sessionId)
        if (sess) sess.lastBridgeStatus = status
        sendBridgeStatus(opts.sessionId, status)
      }
    )

    let spec: Awaited<ReturnType<typeof prepareAgentLaunch>> | undefined
    try {
      const info = await bridge.start()
      const profile = ssh.getProfile(opts.sessionId)
      const persistentSessionId = deriveAgentSessionId(opts.sessionId, profile)
      spec =
        opts.kind === 'devterm'
          ? await (async () => {
              const sessionDir = join(app.getPath('userData'), 'agent-sessions')
              mkdirSync(sessionDir, { recursive: true })
              return prepareBuiltinAgentLaunch(
                buildAgentsMd(context, airGapped, cwds.get(opts.sessionId)),
                info,
                {
                  preferences: opts.preferences,
                  sessionDir,
                  sessionId: persistentSessionId
                }
              )
            })()
          : opts.kind === 'claude'
            ? await prepareClaudeLaunch(
                buildClaudeMd(context, airGapped, cwds.get(opts.sessionId)),
                info
              )
            : opts.kind === 'kimi'
              ? await prepareKimiLaunch(
                  buildKimiMd(context, airGapped, cwds.get(opts.sessionId)),
                  info
                )
              : opts.kind === 'opencode'
                ? await prepareOpencodeLaunch(
                    buildOpencodeMd(context, airGapped, cwds.get(opts.sessionId)),
                    info
                  )
                : opts.kind === 'grok'
                  ? prepareGrokLaunch(
                      buildGrokMd(context, airGapped, cwds.get(opts.sessionId)),
                      info,
                      opts.mode
                    )
                  : opts.kind === 'codex'
                    ? prepareCodexLaunch(
                        buildCodexMd(context, airGapped, cwds.get(opts.sessionId)),
                        info,
                        opts.mode
                      )
                    : opts.kind === 'antigravity'
                      ? await prepareAntigravityLaunch(
                          buildAntigravityMd(context, airGapped, cwds.get(opts.sessionId)),
                          info,
                          opts.mode
                        )
                      : await (async () => {
                          const sessionDir = join(app.getPath('userData'), 'agent-sessions')
                          mkdirSync(sessionDir, { recursive: true })
                          return prepareAgentLaunch(
                            buildAgentsMd(context, airGapped, cwds.get(opts.sessionId)),
                            info,
                            {
                              preferences: opts.preferences,
                              sessionDir,
                              sessionId: persistentSessionId
                            }
                          )
                        })()
      const { id: ptyId } = pty.create(
        {
          shell: spec.bin,
          args: spec.args,
          cwd: spec.cwd,
          env: spec.env,
          cols: opts.cols,
          rows: opts.rows
        },
        reusePtyId
      )

      const sshDispose = ssh.addStatusListener(opts.sessionId, (status: SSHStatus) => {
        const sess = sessions.get(opts.sessionId)
        if (!sess) return
        // Track SSH state so tool calls can return a clear reconnect message
        // instead of "unknown session" (which the agent used to read as a
        // hard failure and crash on).
        if (status.type === 'closed') {
          sess.sshDown = true
          sendBridgeStatus(opts.sessionId, {
            ...(sess.lastBridgeStatus ?? {
              state: 'disconnected',
              mcpUrl: undefined,
              message: 'SSH disconnected',
              lastActivityAt: undefined,
              lastHeartbeatAt: undefined,
              activeStreams: 0
            }),
            state: 'disconnected',
            message: 'SSH disconnected; reconnecting…'
          })
        } else if (status.type === 'reconnecting') {
          sess.sshDown = true
          sendBridgeStatus(opts.sessionId, {
            ...(sess.lastBridgeStatus ?? {
              state: 'disconnected',
              mcpUrl: undefined,
              message: 'SSH reconnecting',
              lastActivityAt: undefined,
              lastHeartbeatAt: undefined,
              activeStreams: 0
            }),
            state: 'disconnected',
            message: `SSH reconnecting (attempt ${status.attempt}/${status.maxAttempts})…`
          })
        } else if (status.type === 'reconnected') {
          sess.sshDown = false
          // Refresh the cached host context now that a fresh detectRemoteContext
          // has run on the new ssh2 client; tool handlers read this through
          // `getContext()`.
          const fresh = ssh.getContext(opts.sessionId)
          if (fresh) sess.lastContext = fresh
          sendBridgeStatus(opts.sessionId, {
            ...(sess.lastBridgeStatus ?? {
              state: 'connected',
              mcpUrl: undefined,
              message: 'SSH reconnected',
              lastActivityAt: Date.now(),
              lastHeartbeatAt: undefined,
              activeStreams: 0
            }),
            state: 'connected',
            message: `SSH reconnected (attempt ${status.attempt})`
          })
          // If the agent process died while SSH was down (most agents exit
          // when their MCP tool loop can't make progress), relaunch it now
          // that the connection is back. The renderer's pane stays mounted;
          // the new PTY binds to the same pane id.
          if (sess.agentExited && sess.lastOpts) {
            sess.agentExited = false
            const restartOpts = {
              ...sess.lastOpts,
              cwd: cwds.get(opts.sessionId) ?? sess.lastOpts.cwd
            }
            const stablePtyId = sess.ptyId
            // Enqueue so a concurrent agent:open (Restart button) cannot race
            // this relaunch and leak a second bridge/tempdir.
            void enqueueLaunch(opts.sessionId, async () => {
              // Fully retire the old bridge/listeners/temp directory before
              // replacing the process. Reuse the PTY id so the renderer's
              // existing per-id data/exit subscriptions remain valid.
              await closeOne(opts.sessionId)
              return launchAgent(restartOpts, stablePtyId)
            }).catch((err) => {
              sendBridgeStatus(opts.sessionId, {
                state: 'error',
                mcpUrl: undefined,
                message: `Auto-restart after reconnect failed: ${(err as Error).message}`,
                lastActivityAt: Date.now(),
                lastHeartbeatAt: undefined,
                activeStreams: 0
              })
            })
          }
        } else if (status.type === 'reconnect-failed') {
          sendBridgeStatus(opts.sessionId, {
            ...(sess.lastBridgeStatus ?? {
              state: 'error',
              mcpUrl: undefined,
              message: 'SSH reconnect failed',
              lastActivityAt: undefined,
              lastHeartbeatAt: undefined,
              activeStreams: 0
            }),
            state: 'error',
            message: `SSH reconnect failed: ${status.reason}`
          })
        }
      })

      const ptyDispose = pty.addExitListener(ptyId, () => {
        const sess = sessions.get(opts.sessionId)
        if (!sess) return
        sess.agentExited = true
        // Don't tear down the bridge here yet: if SSH reconnects shortly, we
        // want to restart the agent in place. closeOne will clean up the
        // bridge + temp dir when the renderer explicitly closes the pane
        // (or the window quits via closeAll).
        sendBridgeStatus(opts.sessionId, {
          ...(sess.lastBridgeStatus ?? {
            state: 'stopped',
            mcpUrl: undefined,
            message: 'Agent exited',
            lastActivityAt: undefined,
            lastHeartbeatAt: undefined,
            activeStreams: 0
          }),
          state: 'stopped',
          message: 'Agent process exited'
        })
      })

      sessions.set(opts.sessionId, {
        bridge,
        ptyId,
        cleanup: spec.cleanup,
        sshDown: false,
        lastContext: context,
        sshDispose,
        ptyDispose,
        agentExited: false,
        lastOpts: opts
      })
      return { ptyId, mcpUrl: info.url }
    } catch (err) {
      // Partial failure cleanup: the bridge may be listening, the launch
      // spec may have written a temp dir, the PTY may not have spawned.
      // Tear down everything we actually created so retries don't pile up
      // orphaned bridges + temp dirs.
      try {
        await bridge.stop()
      } catch {
        /* not started yet */
      }
      try {
        spec?.cleanup()
      } catch {
        /* dir not created */
      }
      throw err
    }
  }

  ipcMain.handle(IPC.agentStatus, (_e, sessionId: string): AgentBridgeStatus | null => {
    return sessions.get(sessionId)?.bridge.getStatus() ?? null
  })

  ipcMain.on(IPC.agentClose, (_e, sessionId: string) => {
    void closeOne(sessionId)
  })

  return {
    closeAll: async () => {
      for (const id of [...sessions.keys()]) await closeOne(id)
    }
  }
}
