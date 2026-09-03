import { ipcMain, BrowserWindow, app, dialog, type OpenDialogOptions } from 'electron'
import { createHash, randomUUID } from 'crypto'
import { mkdirSync, readFileSync, statSync } from 'fs'
import { basename, isAbsolute, join } from 'path'
import {
  IPC,
  type AgentDelegateAck,
  type AgentDelegateRequest,
  type AgentDelegateResult,
  type AgentEffort,
  type AgentListEntry,
  type AgentBridgeStatus,
  type AgentOpenOpts,
  type AgentOpenResult,
  type AgentSessionStatus,
  type AgentTrustedSkill,
  type AgentUiMode,
  type AgentWindowOpenOpts,
  type ConfirmRequest,
  type HostContext,
  type SSHStatus
} from '@shared/types'
import { McpBridge } from '../mcp/server'
import type { ConfirmOutcome } from '../mcp/tools'
import type { AgentHandoffInput } from '../mcp/tools-agent'
import { buildAgentHandoffPrompt } from '../mcp/tools-agent'
import { Policy } from '../mcp/policy'
import * as approvalRules from '../agent/approval-rules'
import * as bridgeActivity from '../agent/bridge-activity'
import {
  buildAgentsMd,
  deriveAgentSessionId,
  deriveLocalAgentSessionId,
  getBuiltinAgentCapabilities,
  prepareAgentLaunch,
  prepareBuiltinAgentLaunch,
  resolveLocalSpawnCwd,
  sweepStaleAgentTempDirs,
  type AgentLaunchExtras
} from '../agent/launch'
import { buildLocalNativeMd, localBrowserToolPrefix } from '../agent/context'
import { assertAgentBinAvailable, normalizeHandoffModel } from '../agent/agent-bin'
import { buildClaudeMd, prepareClaudeLaunch } from '../agent/claude-launch'
import { buildKimiMd, prepareKimiLaunch } from '../agent/kimi-launch'
import { buildOpencodeMd, prepareOpencodeLaunch } from '../agent/opencode-launch'
import { buildGrokMd, prepareGrokLaunch } from '../agent/grok-launch'
import { buildCodexMd, prepareCodexLaunch } from '../agent/codex-launch'
import { buildAntigravityMd, prepareAntigravityLaunch } from '../agent/antigravity-launch'
import {
  LocalHostBackend,
  SshHostBackend,
  localContext as buildLocalContext
} from '../agent/host-backend'
import { browserControl } from '../browser/control-instance'
import type { SSHManager } from '../ssh/manager'
import type { PtyManager } from '../pty/manager'
import { broadcast } from './broadcast'

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
  /** Whether the launcher passed the first message on the CLI (no PTY inject). */
  promptDelivered?: boolean
  /** Last bridge status emitted; reused for `sshDown` mirror so the UI sees it. */
  lastBridgeStatus?: AgentBridgeStatus
}

const MAX_DELEGATED_AGENTS_PER_SOURCE = 4
// Renderer ack budget for a delegated launch: the ack now fires only after the
// new pane's `agent.open` resolves (not on tab placement), so allow time for a
// cold CLI spawn + bridge listen on Windows. Failures still report immediately.
const HANDOFF_WAIT_MS = 30000
const AGENT_READY_WAIT_MS = 20000

const AGENT_EFFORTS: readonly AgentEffort[] = ['low', 'medium', 'high', 'max']
const AGENT_KINDS: readonly AgentOpenOpts['kind'][] = [
  'devterm',
  'pi',
  'claude',
  'opencode',
  'kimi',
  'grok',
  'codex',
  'antigravity'
]

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function agentKindLabel(kind: AgentOpenOpts['kind']): string {
  switch (kind) {
    case 'devterm':
      return 'DevTerm Agent'
    case 'claude':
      return 'Claude'
    case 'opencode':
      return 'OpenCode'
    case 'kimi':
      return 'Kimi'
    case 'grok':
      return 'Grok'
    case 'codex':
      return 'Codex'
    case 'antigravity':
      return 'Antigravity'
    default:
      return 'Pi'
  }
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
  /** Last UI placement reported by the main renderer (docked / floating / hidden). */
  const uiModes = new Map<string, AgentUiMode>()
  /** Floating agent BrowserWindows keyed by remote session id. */
  const agentWindows = new Map<string, BrowserWindow>()
  /** Renderer acknowledgements for in-flight local handoff requests. */
  const handoffWaiters = new Map<
    string,
    {
      sessionId: string
      resolve: (result: AgentDelegateResult) => void
      reject: (error: Error) => void
      timer: ReturnType<typeof setTimeout>
      warnings: string[]
    }
  >()
  /** Delegated local agent ids grouped by their source agent. */
  const delegatedBySource = new Map<string, Set<string>>()

  const sendMain = (channel: string, ...args: unknown[]) => {
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
  }

  const forgetDelegated = (sessionId: string): void => {
    for (const [sourceId, ids] of delegatedBySource) {
      ids.delete(sessionId)
      if (ids.size === 0) delegatedBySource.delete(sourceId)
    }
  }

  const rejectHandoffWaiter = (requestId: string, error: Error): void => {
    const waiter = handoffWaiters.get(requestId)
    if (!waiter) return
    handoffWaiters.delete(requestId)
    clearTimeout(waiter.timer)
    waiter.reject(error)
  }

  // The acknowledgement is emitted by the main renderer after the prescribed
  // session has mounted its AgentPane and the agent.open call has started.
  ipcMain.on(IPC.agentDelegateAck, (event, ack: AgentDelegateAck) => {
    const main = getWindow()
    if (main && event.sender !== main.webContents) return
    if (
      !ack ||
      typeof ack.requestId !== 'string' ||
      typeof ack.sessionId !== 'string' ||
      typeof ack.ok !== 'boolean'
    )
      return
    const waiter = handoffWaiters.get(ack.requestId)
    if (!waiter || waiter.sessionId !== ack.sessionId) return
    handoffWaiters.delete(ack.requestId)
    clearTimeout(waiter.timer)
    if (ack.ok) {
      const target = sessions.get(ack.sessionId)
      const opts = target?.lastOpts
      waiter.resolve({
        sessionId: ack.sessionId,
        kind: opts?.kind ?? 'devterm',
        cwd: cwds.get(ack.sessionId) ?? opts?.cwd ?? '',
        title: opts?.title ?? `${agentKindLabel(opts?.kind ?? 'devterm')} agent`,
        promptDelivered: target?.promptDelivered,
        ...(waiter.warnings.length > 0 ? { warnings: waiter.warnings } : {})
      })
    } else {
      waiter.reject(new Error(ack.error || 'the delegated agent failed to start'))
    }
  })

  const closeAgentWindow = (sessionId: string, notifyMain = false): void => {
    const win = agentWindows.get(sessionId)
    if (!win) return
    agentWindows.delete(sessionId)
    if (!win.isDestroyed()) {
      // Avoid re-entrant closed handler notifying while we are tearing down.
      win.removeAllListeners('closed')
      win.close()
    }
    if (notifyMain) sendMain(IPC.agentWindowClosed, sessionId)
  }

  // Ask the renderer to approve a guarded action (confirm mode / destructive op).
  // Resolves 'timeout' if the operator never answers — distinct from an explicit
  // 'denied' so the tool can tell the agent the connection is still healthy.
  // Broadcast so a floating agent window can approve without switching back.
  const confirm = (sessionId: string, tool: string, detail: string): Promise<ConfirmOutcome> =>
    new Promise((resolve) => {
      const reqId = randomUUID()
      const timer = setTimeout(() => {
        if (pendingConfirms.delete(reqId)) {
          broadcast(IPC.agentConfirmResolved, { reqId, sessionId })
          resolve('timeout')
        }
      }, 120000)
      pendingConfirms.set(reqId, { sessionId, resolve, timer })
      const req: ConfirmRequest = { reqId, sessionId, tool, detail }
      broadcast(IPC.agentConfirm, req)
    })

  ipcMain.on(IPC.agentConfirmReply, (_e, reqId: string, approved: boolean) => {
    const r = pendingConfirms.get(reqId)
    if (r) {
      pendingConfirms.delete(reqId)
      clearTimeout(r.timer)
      r.resolve(approved ? 'approved' : 'denied')
      broadcast(IPC.agentConfirmResolved, { reqId, sessionId: r.sessionId })
    }
  })

  const closeOne = async (sessionId: string): Promise<void> => {
    const s = sessions.get(sessionId)
    if (!s) return
    for (const [requestId, waiter] of handoffWaiters) {
      if (waiter.sessionId === sessionId) {
        rejectHandoffWaiter(
          requestId,
          new Error('The delegated agent was closed before it started.')
        )
      }
    }
    closeAgentWindow(sessionId, false)
    uiModes.delete(sessionId)
    // Fail any in-flight approval prompts for this session immediately —
    // otherwise the tool call pends until the 120s timeout after the pane is
    // already gone.
    for (const [reqId, pending] of pendingConfirms) {
      if (pending.sessionId !== sessionId) continue
      pendingConfirms.delete(reqId)
      clearTimeout(pending.timer)
      pending.resolve('denied')
      broadcast(IPC.agentConfirmResolved, { reqId, sessionId })
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
    delegatedBySource.delete(sessionId)
    forgetDelegated(sessionId)
    // Drop browser-control grants/default targets owned by this agent.
    browserControl().releaseAgent(sessionId)
  }

  const getLocalAgent = (sessionId: string): AgentSession | undefined => {
    const session = sessions.get(sessionId)
    return session?.lastOpts?.sessionKind === 'local' && !session.agentExited ? session : undefined
  }

  const listLocalAgents = (sourceSessionId: string): AgentListEntry[] => {
    const rows: AgentListEntry[] = []
    for (const [sessionId, session] of sessions) {
      const opts = session.lastOpts
      if (!opts || opts.sessionKind !== 'local' || session.agentExited) continue
      const latest = bridgeActivity
        .list(sessionId)
        .slice()
        .reverse()
        .find((entry) => entry.kind === 'tool_call' || entry.kind === 'approval_request')
      rows.push({
        sessionId,
        kind: opts.kind,
        title: opts.title ?? `${agentKindLabel(opts.kind)} agent`,
        cwd: cwds.get(sessionId) ?? opts.cwd,
        bridge: session.bridge.getStatus().state,
        lastTask: latest ? `${latest.tool}${latest.detail ? `: ${latest.detail}` : ''}` : undefined,
        isSelf: sessionId === sourceSessionId
      })
    }
    return rows.sort((a, b) => a.sessionId.localeCompare(b.sessionId))
  }

  const validateHandoffCwd = (requested: string | undefined, sourceId: string): string => {
    const candidate =
      requested?.trim() || cwds.get(sourceId) || sessions.get(sourceId)?.lastOpts?.cwd
    if (!candidate) {
      throw new Error('The source agent working directory is not known yet.')
    }
    if (!isAbsolute(candidate)) {
      throw new Error('The handoff cwd must be an absolute path.')
    }
    try {
      if (!statSync(candidate).isDirectory()) throw new Error('not a directory')
    } catch {
      throw new Error(`The handoff cwd does not exist or is not a directory: ${candidate}`)
    }
    return candidate
  }

  const handoffTitle = (kind: AgentOpenOpts['kind'], title: string | undefined, prompt: string) => {
    const label = agentKindLabel(kind)
    const clean = title
      ?.replace(/[\r\n]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80)
    if (clean) return `${label} · ${clean}`
    const preview = prompt
      .replace(/[\r\n]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 56)
    return `${label} · ${preview || 'handoff'}`
  }

  const delegateFrom = async (
    sourceSessionId: string,
    input: AgentHandoffInput
  ): Promise<AgentDelegateResult> => {
    const t0 = Date.now()
    try {
      return await delegateFromInner(sourceSessionId, input)
    } catch (error) {
      // The MCP wrapper logs the call itself as ok (the handler returns an
      // error payload instead of throwing), so leave an explicit failed row —
      // otherwise a rejected delegate is invisible in the activity panel.
      bridgeActivity.record({
        sessionId: sourceSessionId,
        kind: 'tool_call',
        tool: 'agent_delegate',
        detail: (error instanceof Error ? error.message : String(error)).slice(0, 200),
        durationMs: Date.now() - t0,
        ok: false
      })
      throw error
    }
  }

  const delegateFromInner = async (
    sourceSessionId: string,
    input: AgentHandoffInput
  ): Promise<AgentDelegateResult> => {
    const source = getLocalAgent(sourceSessionId)
    if (!source?.lastOpts) throw new Error('Agent handoff is available only from local agents.')
    const delegated = delegatedBySource.get(sourceSessionId) ?? new Set<string>()
    for (const delegatedId of delegated) {
      const target = sessions.get(delegatedId)
      if (!target || target.agentExited) delegated.delete(delegatedId)
    }
    if (delegated.size >= MAX_DELEGATED_AGENTS_PER_SOURCE) {
      throw new Error(
        `Delegate cap reached: one local agent may have at most ${MAX_DELEGATED_AGENTS_PER_SOURCE} live delegated agents.`
      )
    }
    if (typeof input.prompt !== 'string' || input.prompt.trim().length === 0) {
      throw new Error('The handoff prompt must not be empty.')
    }
    if (input.prompt.length > 30000) {
      throw new Error('The handoff prompt is too large (maximum 30,000 characters).')
    }
    if (!AGENT_EFFORTS.includes(input.effort as AgentEffort)) {
      if (input.effort !== undefined)
        throw new Error(`Unknown reasoning effort: ${String(input.effort)}`)
    }
    const model = input.model?.trim()
    if (model && (model.length > 240 || /[\0\r\n]/u.test(model))) {
      throw new Error('The handoff model must be a short single-line value.')
    }
    const cwd = validateHandoffCwd(input.cwd, sourceSessionId)
    if (!AGENT_KINDS.includes(input.kind)) {
      throw new Error(`Unknown local agent kind: ${String(input.kind)}`)
    }
    // Fail fast when the target CLI is not installed: without this the caller
    // gets a success ack, a tab flashes open, and the spawn dies a second
    // later with the binary missing.
    await assertAgentBinAvailable(input.kind)
    // Orca rule: never pass a model flag the launcher cannot honor. A bogus
    // `--model` kills the new TUI on startup; drop it with a warning so the
    // worker starts on the operator default instead.
    const normalized = normalizeHandoffModel(input.kind, model || undefined)
    const warnings = normalized.warnings
    const layout = input.layout ?? 'tab'
    if (layout !== 'tab' && layout !== 'split') {
      throw new Error(`Unknown handoff layout: ${String(input.layout)}`)
    }
    const kind = input.kind
    const title = handoffTitle(kind, input.title, input.prompt)
    const sessionId = `local-agent-${Date.now()}-${randomUUID().slice(0, 8)}`
    const requestId = randomUUID()
    const prompt = buildAgentHandoffPrompt({
      sourceKind: source.lastOpts.kind,
      sourceSessionId,
      sessionId,
      cwd,
      kind,
      model: normalized.model,
      effort: input.effort,
      modelNote: warnings[0],
      prompt: input.prompt
    })
    const request: AgentDelegateRequest = {
      requestId,
      sourceSessionId,
      sourceKind: source.lastOpts.kind,
      sessionId,
      kind,
      cwd,
      prompt,
      model: normalized.model,
      effort: input.effort,
      title,
      layout
    }
    const win = getWindow()
    if (!win || win.isDestroyed()) throw new Error('The DevTerm main window is unavailable.')

    delegated.add(sessionId)
    delegatedBySource.set(sourceSessionId, delegated)
    let accepted = false
    const pending = new Promise<AgentDelegateResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        handoffWaiters.delete(requestId)
        reject(new Error('The delegated agent pane did not start in time.'))
      }, HANDOFF_WAIT_MS)
      handoffWaiters.set(requestId, { sessionId, resolve, reject, timer, warnings })
    })
    try {
      win.webContents.send(IPC.agentDelegateRequest, request)
      const result = await pending
      accepted = true
      return result
    } finally {
      const waiter = handoffWaiters.get(requestId)
      if (waiter) {
        handoffWaiters.delete(requestId)
        clearTimeout(waiter.timer)
      }
      if (!accepted) forgetDelegated(sessionId)
    }
  }

  const waitForAgentReady = async (agent: AgentSession): Promise<void> => {
    const start = Date.now()
    while (Date.now() - start < AGENT_READY_WAIT_MS) {
      const state = agent.bridge.getStatus().state
      // A listening bridge only means the HTTP server exists. Wait for the
      // CLI's MCP handshake so a follow-up cannot land in its startup banner.
      if (state === 'connected') return
      if (state === 'error' || state === 'stopped') break
      await sleep(250)
    }
    throw new Error('The target local agent is not ready to receive a message.')
  }

  const waitForPtyQuiet = async (ptyId: string): Promise<void> => {
    await new Promise<void>((resolve) => {
      let last = Date.now()
      let quietTimer: ReturnType<typeof setTimeout> | undefined
      let dispose: () => void = () => undefined
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        if (quietTimer) clearTimeout(quietTimer)
        clearTimeout(limit)
        dispose()
        resolve()
      }
      const schedule = () => {
        if (quietTimer) clearTimeout(quietTimer)
        quietTimer = setTimeout(() => {
          if (Date.now() - last >= 280) finish()
          else schedule()
        }, 280)
      }
      dispose = pty.addDataListener(ptyId, () => {
        last = Date.now()
        schedule()
      })
      const limit = setTimeout(finish, 20000)
      schedule()
    })
  }

  const messageLocalAgent = async (
    sourceSessionId: string,
    targetSessionId: string,
    message: string
  ): Promise<void> => {
    const source = getLocalAgent(sourceSessionId)
    if (!source) throw new Error('Agent messaging is available only from local agents.')
    if (sourceSessionId === targetSessionId) throw new Error('An agent cannot message itself.')
    const target = getLocalAgent(targetSessionId)
    if (!target || target.agentExited) throw new Error('The target local agent is not running.')
    const trimmed = message.replace(/\s+$/u, '')
    if (!trimmed) throw new Error('The message must not be empty.')
    if (trimmed.length > 30000)
      throw new Error('The message is too large (maximum 30,000 characters).')
    await waitForAgentReady(target)
    await waitForPtyQuiet(target.ptyId)
    await sleep(80)
    pty.input(target.ptyId, trimmed)
    await sleep(80)
    pty.input(target.ptyId, '\r')
  }

  // Live cwd updates from the renderer's OSC 7 tracking. Fire-and-forget: a
  // stray update before the agent is open is harmless (the next open seeds from
  // opts.cwd and the renderer re-pushes), so we just record the latest value.
  ipcMain.on(IPC.agentSetCwd, (_e, sessionId: string, cwd: string) => {
    if (typeof cwd === 'string' && cwd) cwds.set(sessionId, cwd)
  })

  const sendBridgeStatus = (sessionId: string, status: AgentBridgeStatus) =>
    broadcast(`${IPC.agentBridgeStatus}:${sessionId}`, status)

  ipcMain.handle(IPC.agentOpen, async (_e, opts: AgentOpenOpts): Promise<AgentOpenResult> => {
    // Serialize against reconnect auto-restart for the same session id.
    return enqueueLaunch(opts.sessionId, async () => {
      const existing = sessions.get(opts.sessionId)
      // Reattach path: UI mode changes (dock / float / hide / ask-strip) must
      // not kill a healthy agent. Restart only when explicitly requested or
      // when the previous agent process has already exited.
      if (existing && !opts.forceRestart && !existing.agentExited) {
        const bridge = existing.bridge.getStatus()
        return {
          ptyId: existing.ptyId,
          mcpUrl: bridge.mcpUrl ?? '',
          reused: true
        }
      }
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
    // Local agents run on this workstation; remote agents over the session's
    // ssh2 client. Browser tools are host-agnostic and work on both.
    const isLocal = opts.sessionKind === 'local'
    const context = isLocal ? buildLocalContext() : ssh.getContext(opts.sessionId)
    if (!context) throw new Error('Connect the SSH session before opening the agent.')

    if (opts.cwd) cwds.set(opts.sessionId, opts.cwd)

    const policy = new Policy(opts.mode ?? 'full', (sessionId, command) =>
      approvalRules.match(sessionId, command).then((r) => (r ? { outcome: r.outcome } : undefined))
    )
    const airGapped = opts.airGapped ?? false
    const browserOn = opts.browserTools !== false
    const handoffOn = opts.preferences?.agentHandoff !== false
    const spawnCwd = isLocal
      ? resolveLocalSpawnCwd(cwds.get(opts.sessionId) ?? opts.cwd)
      : undefined
    const extras: AgentLaunchExtras = {
      model: opts.model,
      effort: opts.effort,
      initialPrompt: opts.initialPrompt,
      ...(isLocal
        ? {
            nativeLocal: true,
            spawnCwd,
            appendSystemPrompt: buildLocalNativeMd(context, {
              cwd: spawnCwd,
              browserTools: browserOn,
              agentHandoff: handoffOn,
              toolPrefix: localBrowserToolPrefix(opts.kind)
            })
          }
        : {})
    }
    const remoteBriefing = (builder: typeof buildAgentsMd) =>
      builder(context, airGapped, cwds.get(opts.sessionId))
    const bridge = new McpBridge(
      {
        sessionId: opts.sessionId,
        host: isLocal
          ? new LocalHostBackend()
          : new SshHostBackend(
              ssh,
              opts.sessionId,
              () => sessions.get(opts.sessionId)?.sshDown ?? false
            ),
        getContext: () =>
          isLocal
            ? (sessions.get(opts.sessionId)?.lastContext ?? context)
            : (ssh.getContext(opts.sessionId) ?? context),
        hostDown: () => (isLocal ? false : (sessions.get(opts.sessionId)?.sshDown ?? false)),
        airGapped,
        policy,
        getCwd: () => cwds.get(opts.sessionId),
        confirm: (tool, detail) => confirm(opts.sessionId, tool, detail),
        browser: { service: browserControl(), enabled: browserOn },
        agentHandoff: isLocal
          ? {
              enabled: handoffOn,
              list: () => listLocalAgents(opts.sessionId),
              delegate: (input) => delegateFrom(opts.sessionId, input),
              message: (targetSessionId, message) =>
                messageLocalAgent(opts.sessionId, targetSessionId, message)
            }
          : undefined,
        // Local agents use built-in fs/shell tools. MCP is browser-only.
        hostTools: !isLocal
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
      const profile = isLocal ? undefined : ssh.getProfile(opts.sessionId)
      const persistentSessionId = isLocal
        ? deriveLocalAgentSessionId(spawnCwd)
        : deriveAgentSessionId(opts.sessionId, profile)
      const piOpts = {
        preferences: opts.preferences,
        sessionDir: join(app.getPath('userData'), 'agent-sessions'),
        sessionId: persistentSessionId,
        ...extras,
        approveProject: isLocal
      }
      spec =
        opts.kind === 'devterm'
          ? await (async () => {
              mkdirSync(piOpts.sessionDir, { recursive: true })
              return prepareBuiltinAgentLaunch(remoteBriefing(buildAgentsMd), info, piOpts)
            })()
          : opts.kind === 'claude'
            ? await prepareClaudeLaunch(remoteBriefing(buildClaudeMd), info, extras)
            : opts.kind === 'kimi'
              ? await prepareKimiLaunch(remoteBriefing(buildKimiMd), info, extras)
              : opts.kind === 'opencode'
                ? await prepareOpencodeLaunch(remoteBriefing(buildOpencodeMd), info, extras)
                : opts.kind === 'grok'
                  ? prepareGrokLaunch(remoteBriefing(buildGrokMd), info, extras)
                  : opts.kind === 'codex'
                    ? prepareCodexLaunch(remoteBriefing(buildCodexMd), info, extras)
                    : opts.kind === 'antigravity'
                      ? await prepareAntigravityLaunch(
                          remoteBriefing(buildAntigravityMd),
                          info,
                          extras
                        )
                      : await (async () => {
                          mkdirSync(piOpts.sessionDir, { recursive: true })
                          return prepareAgentLaunch(remoteBriefing(buildAgentsMd), info, piOpts)
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

      // Remote only: track SSH state so tool calls can return a clear
      // reconnect message instead of "unknown session". Local agents have no
      // transport to drop.
      const sshDispose = isLocal
        ? undefined
        : ssh.addStatusListener(opts.sessionId, (status: SSHStatus) => {
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
        lastOpts: { ...opts, initialPrompt: undefined },
        promptDelivered: spec.promptDelivered
      })
      return { ptyId, mcpUrl: info.url, promptDelivered: spec.promptDelivered }
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

  ipcMain.handle(IPC.agentStatus, (_e, sessionId: string): AgentSessionStatus | null => {
    const s = sessions.get(sessionId)
    if (!s) return null
    const opts = s.lastOpts
    if (!opts) return null
    return {
      ptyId: s.ptyId,
      kind: opts.kind,
      mode: opts.mode ?? 'full',
      bridge: s.bridge.getStatus(),
      uiMode: uiModes.get(sessionId)
    }
  })

  ipcMain.on(IPC.agentClose, (_e, sessionId: string) => {
    void closeOne(sessionId)
  })

  ipcMain.on(IPC.agentSetUiMode, (_e, sessionId: string, mode: AgentUiMode | null) => {
    if (typeof sessionId !== 'string') return
    if (mode === null || mode === undefined) {
      uiModes.delete(sessionId)
      closeAgentWindow(sessionId, false)
      broadcast(IPC.agentUiModeChanged, { sessionId, mode: null })
      return
    }
    if (mode !== 'docked' && mode !== 'floating' && mode !== 'hidden') return
    uiModes.set(sessionId, mode)
    if (mode !== 'floating') closeAgentWindow(sessionId, false)
    // Tell every renderer (especially the main window) so store state matches
    // when a floating window docks/hides itself.
    broadcast(IPC.agentUiModeChanged, { sessionId, mode })
  })

  ipcMain.handle(IPC.agentWindowOpen, async (_e, opts: AgentWindowOpenOpts): Promise<void> => {
    if (!opts || typeof opts.sessionId !== 'string') return
    const { sessionId } = opts
    const existing = agentWindows.get(sessionId)
    if (existing && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore()
      existing.show()
      existing.focus()
      return
    }

    uiModes.set(sessionId, 'floating')
    const hostLabel = (opts.title || 'agent').replace(/[^\w.@\-: ]+/g, '').slice(0, 64)
    const win = new BrowserWindow({
      width: 720,
      height: 640,
      minWidth: 420,
      minHeight: 320,
      show: false,
      frame: true,
      transparent: false,
      backgroundColor: '#16161e',
      title: hostLabel ? `Agent · ${hostLabel}` : 'DevTerm Agent',
      autoHideMenuBar: true,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        autoplayPolicy: 'no-user-gesture-required',
        backgroundThrottling: false,
        webviewTag: false
      }
    })
    agentWindows.set(sessionId, win)

    const params = new URLSearchParams({
      sessionId,
      kind: opts.kind,
      mode: opts.mode,
      title: opts.title ?? ''
    })

    win.on('ready-to-show', () => win.show())
    win.on('closed', () => {
      if (agentWindows.get(sessionId) === win) agentWindows.delete(sessionId)
      // User closed the pop-out: keep the agent process, demote UI to hidden.
      if (uiModes.get(sessionId) === 'floating') {
        uiModes.set(sessionId, 'hidden')
        broadcast(IPC.agentUiModeChanged, { sessionId, mode: 'hidden' as AgentUiMode })
      }
      sendMain(IPC.agentWindowClosed, sessionId)
    })
    win.on('focus', () => win.flashFrame(false))

    if (process.env.ELECTRON_RENDERER_URL) {
      await win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/agent-window.html?${params}`)
    } else {
      await win.loadFile(join(__dirname, '../renderer/agent-window.html'), {
        query: Object.fromEntries(params.entries())
      })
    }
  })

  ipcMain.on(IPC.agentWindowClose, (_e, sessionId: string) => {
    if (typeof sessionId !== 'string') return
    closeAgentWindow(sessionId, false)
  })

  return {
    closeAll: async () => {
      for (const requestId of [...handoffWaiters.keys()]) {
        rejectHandoffWaiter(requestId, new Error('DevTerm is closing local agent handoffs.'))
      }
      delegatedBySource.clear()
      for (const id of [...agentWindows.keys()]) closeAgentWindow(id, false)
      for (const id of [...sessions.keys()]) await closeOne(id)
    }
  }
}
