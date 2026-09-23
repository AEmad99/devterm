import { create } from 'zustand'
import type {
  AgentBridgeState,
  AgentLaunchRequest,
  AgentKind,
  AgentUiMode,
  HostContext,
  PolicyMode,
  SSHProfile,
  SessionRestoreBrowserTab,
  PreviewMeta
} from '@shared/types'
import { useLayout } from './layout'
import { encodeJump, listJumpHops } from '@shared/ssh-jump'

const statusDisposers = new Map<string, () => void>()
/** Profiles for remote tabs that have been painted but not connected yet. */
const deferredRemoteProfiles = new Map<string, SSHProfile>()
/** De-duplicate focus/restore clicks while one deferred connection is opening. */
const deferredRemoteConnects = new Map<string, Promise<string | null>>()

type DeferredCredentials = {
  password?: string
  passphrase?: string
  jumpPassword?: string
  jumpPassphrase?: string
}

export interface Session {
  id: string
  kind: 'local' | 'remote' | 'browser'
  title: string
  context?: HostContext
  /** Transient status line (connecting, host-key warnings, errors, closed). */
  status?: string
  closed?: boolean
  /** Current working directory of the session's shell (from OSC 7). */
  cwd?: string
  /** For remote sessions opened from a saved connection: that connection's id. */
  connectionId?: string
  /** True while a saved remote is represented by a painted, not-yet-connected tab. */
  deferredRemote?: boolean
  /** Display number for local terminals ("Local N"); reused as terminals close. */
  localNum?: number
  /**
   * True when the user has manually renamed the tab. Keeps the dynamic label
   * generator from clobbering their chosen title.
   */
  customTitle?: boolean
  /**
   * Most recent command the operator submitted in this terminal (typed + Enter).
   * Used to show "what is running" in the tab label; cleared when a new prompt
   * returns (OSC 133 ;A) or the terminal exits.
   */
  currentCommand?: string
  /**
   * Current task the agent is working on, e.g. "read_file src/main.ts". Set by
   * AgentPane from live bridge activity so the tab states what the agent is doing.
   */
  agentTask?: string
  /** Which agent kind is running in this session's agent pane, if any. */
  agentKind?: AgentKind
  /** One-time handoff launch payload consumed by the first AgentPane mount. */
  agentLaunch?: AgentLaunchRequest
  /**
   * Where the agent terminal UI is placed. Absent means no agent session is
   * desired (process stopped). Process can still run while `hidden`.
   */
  agentUiMode?: AgentUiMode
  /** MCP policy used for the active agent (always `full`; kept for IPC). */
  agentPolicyMode?: PolicyMode
  /** PTY id of the live agent process, if known (for prompt inject without open). */
  agentPtyId?: string
  /**
   * Initial working directory to open the shell in (best-effort), set when a
   * session is launched from a saved workspace. Consumed once by TerminalView on
   * mount; live cwd afterwards is tracked separately in `cwd`.
   */
  startCwd?: string
  /**
   * Top-level terminal group this session belongs to. A fresh terminal lands in
   * the active group, which is the home group until the operator switches.
   * Drives the group tabs; see store/layout.ts.
   */
  groupId?: string
  /** Browser panes only: initial URL to load on mount (consumed once, like startCwd). */
  url?: string
  /** Browser panes only: restorable in-pane tabs, mirrored by BrowserPane. */
  browserTabs?: SessionRestoreBrowserTab[]
  /** Browser panes opened as Preview + annotate. */
  preview?: PreviewMeta
  /** Zero-based active browser tab index for restore. */
  browserActiveTab?: number
  /**
   * Browser panes created by an agent (browser_* MCP tools): the owning
   * agent's session id. Drives the AGENT tab chip and lets open requests
   * extend this pane instead of spawning new ones.
   */
  agentOwnedBy?: string
  /**
   * Browser panes only: pre-agreed key for the FIRST tab so its registration
   * matches an in-flight agent browser_open request. Consumed once on mount.
   */
  firstTabKey?: string
  /**
   * Live state of the MCP bridge for this session's agent (the `pi` CLI wired
   * to a per-session MCP server). Pushed by AgentPane from the bridge-status
   * channel; the tab dot uses it to color the indicator when the bridge is
   * starting / errored. Absent for sessions that have never had an agent.
   */
  agentBridgeState?: AgentBridgeState
  /**
   * True when the agent is waiting on an operator approval for a guarded
   * action (confirm mode, destructive op). Pushed by the confirm-queue
   * subscriber; cleared when the queue reports the request is resolved. Drives
   * the yellow "agent needs your attention" dot.
   */
  agentPendingApproval?: boolean
  /**
   * True when this session has raised an attention signal (an agent finished or
   * a terminal bell rang) that the operator hasn't looked at yet. Set by
   * lib/attention.ts; cleared when the session becomes active or the window
   * refocuses on it. Drives the green "needs attention" tab dot.
   */
  needsAttention?: boolean
  /** True when the agent process has exited (bridge may still be up). */
  agentExited?: boolean
  /** Set when agent.open fails, so a hidden or floating agent still shows the error. */
  agentStartError?: string
  /** Incremented to ask the mounted AgentPane to relaunch (restart button). */
  agentRestartNonce?: number
  /** Wall clock when the current agent UI session started (cockpit age). */
  agentStartedAt?: number
  /** True when new output has arrived while this session was not active. */
  hasUnreadOutput?: boolean
  /** True when a command is running in this session (set on Enter, cleared on prompt/exit). */
  processRunning?: boolean
  /** Last shell exit code, if known. null for remote closes without a code. */
  exitCode?: number | null
  /** Ad-hoc SSH profile retained in memory for last-session restore. */
  restoreProfile?: SSHProfile
  /** Opaque safeStorage id for an ad-hoc restore credential. */
  restoreSecretId?: string
  /** Raw ANSI tail loaded from the previous process, consumed by TerminalView. */
  restoreScrollback?: string
  /** A restored ad-hoc remote cannot connect until the operator supplies a secret. */
  needsAuth?: boolean
}

interface SessionState {
  sessions: Session[]
  activeId: string | null
  lastActiveId: string | null
  /**
   * Open a local shell; returns the new session id. `cwd` sets its starting
   * directory, `groupId` its terminal group (defaults to the active group).
   */
  addLocal: (opts?: {
    id?: string
    cwd?: string
    groupId?: string
    title?: string
    restoreScrollback?: string
  }) => string
  /** Paint a remote tab without opening its SSH transport yet. */
  addDeferredRemote: (opts: {
    profile: SSHProfile
    connectionId?: string
    startCwd?: string
    groupId?: string
    title?: string
    restoreScrollback?: string
    needsAuth?: boolean
    restoreSecretId?: string
  }) => string
  /** Connect a remote session; resolves to the real session id (or null on failure). */
  connectSsh: (
    profile: SSHProfile,
    meta?: {
      connectionId?: string
      startCwd?: string
      groupId?: string
      title?: string
      /** Replace an already-painted pending tab in place. */
      replaceId?: string
      /** Do not steal the active tab while a hidden group connects. */
      activate?: boolean
    }
  ) => Promise<string | null>
  /** Start a painted remote tab when its group is focused. */
  connectDeferred: (id: string) => Promise<string | null>
  /** Supply missing credentials for a restored ad-hoc SSH tab. */
  setDeferredCredentials: (id: string, credentials: DeferredCredentials) => void
  /** Cancel any in-flight auto-reconnect loop for the given session. */
  cancelSshReconnect: (sessionId: string) => void
  /** Retry a dropped SSH session in place (same tab, saved profile on the main side). */
  retrySshReconnect: (sessionId: string) => void
  /** Open an in-app browser pane; returns the new session id. Spawns no pty/ssh. */
  addBrowser: (opts?: {
    url?: string
    groupId?: string
    agentOwnedBy?: string
    firstTabKey?: string
    browserTabs?: SessionRestoreBrowserTab[]
    browserActiveTab?: number
    preview?: PreviewMeta
    title?: string
  }) => string
  setActive: (id: string) => void
  /** Move a session into another terminal group (the layout sync reconciles trees). */
  setGroup: (id: string, groupId: string) => void
  setStatus: (id: string, status: string) => void
  /** Update a session's tab title (browser panes push the page title here). */
  setTitle: (id: string, title: string) => void
  /** Keep a browser pane's restorable URL aligned with its active in-pane tab. */
  setBrowserUrl: (id: string, url: string) => void
  /** Mirror every browser tab into the session snapshot state. */
  setBrowserTabs: (id: string, tabs: SessionRestoreBrowserTab[], activeIndex: number) => void
  /** Drop a disk-restored ANSI tail after TerminalView has delivered it. */
  clearRestoreScrollback: (id: string) => void
  /** Set a user-chosen tab title and mark it custom so dynamic labels don't overwrite it. */
  setCustomTitle: (id: string, title: string) => void
  setCwd: (id: string, cwd: string) => void
  /** Update the command currently running in this terminal (set on Enter, cleared on prompt). */
  setCurrentCommand: (id: string, command: string | undefined) => void
  /** Set the current agent task surfaced from bridge activity. */
  setAgentTask: (id: string, task: string | undefined, kind?: AgentKind) => void
  /** Store a one-time initial prompt/model/effort for the next AgentPane mount. */
  setAgentLaunch: (id: string, launch: AgentLaunchRequest) => void
  /** Consume the one-time launch payload without reusing it on remounts. */
  consumeAgentLaunch: (id: string) => AgentLaunchRequest | undefined
  /**
   * Update agent UI placement + optional live metadata. Pass `mode: null` to
   * clear placement after the agent is stopped.
   */
  setAgentUi: (
    id: string,
    patch: {
      mode?: AgentUiMode | null
      kind?: AgentKind
      policyMode?: PolicyMode
      ptyId?: string | null
    },
    /** Skip main IPC (used when applying a mode broadcast from main). */
    opts?: { localOnly?: boolean }
  ) => void
  markClosed: (id: string) => void
  close: (id: string) => void
  /**
   * Update the session's agent-bridge state. Pushed from AgentPane whenever
   * the bridge-status channel fires; no-op when the value is unchanged.
   */
  setAgentBridgeState: (id: string, state: AgentBridgeState) => void
  /**
   * Mark / clear the session's "an agent approval is awaiting the operator"
   * flag. Called by the confirm-queue subscriber; the actual request lives in
   * ConfirmActionModal's local state, this is just a fast lookup for the
   * tab dot to color on.
   */
  setAgentPendingApproval: (id: string, pending: boolean) => void
  /**
   * Set / clear the session's "needs attention" flag (an agent finished or a
   * bell rang). Set by lib/attention.ts; cleared automatically when the session
   * becomes active. Drives the green attention tab dot.
   */
  setNeedsAttention: (id: string, pending: boolean) => void
  /** Set / clear the "new output arrived while not active" badge. */
  setHasUnreadOutput: (id: string, unread: boolean) => void
  /** Set / clear whether the agent process has exited for this session. */
  setAgentExited: (id: string, exited: boolean) => void
  /** Record or clear an agent.open failure for the cockpit and status bar. */
  setAgentStartError: (id: string, message: string | undefined) => void
  /** Ask the mounted AgentPane for this session to relaunch the agent. */
  bumpAgentRestart: (id: string) => void
  /** Set / clear whether a process is currently running in this session. */
  setProcessRunning: (id: string, running: boolean) => void
  /** Record the shell's last exit code. */
  setExitCode: (id: string, code: number | null) => void
}

export const useSessions = create<SessionState>((set, get) => ({
  sessions: [],
  activeId: null,
  lastActiveId: null,

  addLocal: (opts) => {
    // Number from the lowest free slot among open local terminals, so closing
    // tabs frees their numbers and new ones reuse the gaps (1,2,3 → close 2,3 →
    // next are 2,3 again). Never just an ever-climbing counter.
    const used = new Set(
      get()
        .sessions.filter((x) => x.kind === 'local' && x.localNum)
        .map((x) => x.localNum as number)
    )
    let n = 1
    while (used.has(n)) n++
    const id = opts?.id ?? `local-${crypto.randomUUID()}`
    if (get().sessions.some((x) => x.id === id))
      throw new Error(`Session id is already active: ${id}`)
    const session: Session = {
      id,
      kind: 'local',
      title: opts?.title || `Local ${n}`,
      localNum: n,
      customTitle: !!opts?.title,
      startCwd: opts?.cwd,
      // Seed live cwd so the file explorer opens on the launch directory
      // before the first OSC 7 prompt reports; OSC 7 overwrites this later.
      cwd: opts?.cwd,
      groupId: opts?.groupId ?? useLayout.getState().activeGroupId,
      context: { kind: 'local', os: 'unknown', detail: '', hostname: '' },
      restoreScrollback: opts?.restoreScrollback
    }
    set((s) => ({ sessions: [...s.sessions, session], activeId: id }))
    // Enrich with the real local context.
    window.devterm.localContext().then((ctx) =>
      set((s) => ({
        sessions: s.sessions.map((x) => (x.id === id ? { ...x, context: ctx } : x))
      }))
    )
    return id
  },

  connectSsh: async (profile, meta) => {
    const tempId = meta?.replaceId ?? `pending-${crypto.randomUUID()}`
    const existing = get().sessions.find((x) => x.id === tempId)
    const pending: Session = {
      id: tempId,
      kind: 'remote',
      title: meta?.title ?? `${profile.username}@${profile.host}`,
      status: 'connecting…',
      connectionId: meta?.connectionId,
      startCwd: meta?.startCwd,
      // Provisional cwd for workspace restore / reconnect; OSC 7 confirms.
      cwd: meta?.startCwd,
      groupId: meta?.groupId ?? existing?.groupId ?? useLayout.getState().activeGroupId,
      customTitle: meta?.title ? true : existing?.customTitle,
      deferredRemote: existing?.deferredRemote,
      restoreProfile: existing?.restoreProfile ?? (!meta?.connectionId ? profile : undefined),
      restoreSecretId: existing?.restoreSecretId,
      restoreScrollback: existing?.restoreScrollback,
      needsAuth: existing?.needsAuth
    }
    set((s) => ({
      sessions: s.sessions.some((x) => x.id === tempId)
        ? s.sessions.map((x) => (x.id === tempId ? { ...x, ...pending, closed: false } : x))
        : [...s.sessions, pending],
      activeId: meta?.activate === false ? s.activeId : tempId
    }))
    try {
      const { sessionId, context } = await window.devterm.ssh.connect(profile)
      // Subscribe to non-fatal status events for the real session id.
      const dispose = window.devterm.ssh.onStatus(sessionId, (st) => {
        if (st.type === 'hostkey-new')
          get().setStatus(sessionId, `new host key trusted (${st.fingerprint})`)
        else if (st.type === 'hostkey-mismatch')
          get().setStatus(sessionId, `⚠ HOST KEY MISMATCH for ${st.host} — possible MITM`)
        else if (st.type === 'error') get().setStatus(sessionId, `error: ${st.message}`)
        else if (st.type === 'closed') get().markClosed(sessionId)
        else if (st.type === 'reconnecting')
          get().setStatus(
            sessionId,
            `reconnecting… attempt ${st.attempt}/${st.maxAttempts} in ${Math.round(st.delayMs / 100) / 10}s`
          )
        else if (st.type === 'reconnected') {
          // A successful auto-reconnect revives the session: clear the closed
          // tombstone so the reconnect overlay, Open Agent, workspace capture,
          // and session restore all treat it as live again.
          set((s) => ({
            sessions: s.sessions.map((x) =>
              x.id === sessionId
                ? { ...x, closed: false, processRunning: false, exitCode: undefined }
                : x
            )
          }))
          get().setStatus(sessionId, `reconnected (attempt ${st.attempt})`)
        } else if (st.type === 'reconnect-failed')
          get().setStatus(sessionId, `reconnect failed after ${st.attempts} attempts: ${st.reason}`)
      })
      statusDisposers.set(sessionId, dispose)
      const pendingBeforeSwap = get().sessions.some((x) => x.id === tempId)
      if (pendingBeforeSwap) useLayout.getState().replaceSessionId(tempId, sessionId)
      set((s) => {
        const stillPending = s.sessions.some((x) => x.id === tempId)
        const activeId =
          meta?.activate === false
            ? s.activeId
            : stillPending
              ? s.activeId === tempId
                ? sessionId
                : s.activeId
              : s.sessions.some((x) => x.id === s.activeId)
                ? s.activeId
                : (s.sessions[0]?.id ?? null)
        if (!stillPending) {
          // The tab was closed while connect was in flight (pending- close skips
          // disconnect): tear down the ssh2 client we just established.
          dispose()
          statusDisposers.delete(sessionId)
          window.devterm.ssh.disconnect(sessionId)
        }
        return {
          sessions: s.sessions.map((x) =>
            x.id === tempId
              ? {
                  ...x,
                  id: sessionId,
                  title: x.customTitle
                    ? x.title
                    : `${profile.username}@${context.hostname || profile.host}`,
                  context,
                  status: `connected · ${context.os}`,
                  deferredRemote: undefined,
                  closed: false
                }
              : x
          ),
          activeId
        }
      })
      return sessionId
    } catch (e) {
      set((s) => ({
        sessions: s.sessions.map((x) =>
          x.id === tempId
            ? {
                ...x,
                status: `failed: ${e instanceof Error ? e.message : String(e)}`,
                // Keep painted lazy tabs retryable and visible after a failed
                // restore/workspace/grid connection. Normal new connections
                // retain the existing closed-on-failure behavior.
                closed: x.deferredRemote ? false : true
              }
            : x
        )
      }))
      return null
    }
  },

  addDeferredRemote: (opts) => {
    const id = `pending-${crypto.randomUUID()}`
    const session: Session = {
      id,
      kind: 'remote',
      title: opts.title ?? `${opts.profile.username}@${opts.profile.host}`,
      customTitle: !!opts.title,
      status: 'waiting for focus',
      connectionId: opts.connectionId,
      startCwd: opts.startCwd,
      cwd: opts.startCwd,
      groupId: opts.groupId ?? useLayout.getState().activeGroupId,
      deferredRemote: true,
      restoreProfile: opts.profile,
      restoreScrollback: opts.restoreScrollback,
      needsAuth: opts.needsAuth,
      restoreSecretId: opts.restoreSecretId
    }
    deferredRemoteProfiles.set(id, opts.profile)
    set((s) => ({ sessions: [...s.sessions, session], activeId: id }))
    return id
  },

  connectDeferred: (id) => {
    const existingPromise = deferredRemoteConnects.get(id)
    if (existingPromise) return existingPromise
    const session = get().sessions.find((x) => x.id === id)
    const profile = deferredRemoteProfiles.get(id)
    if (!session?.deferredRemote || session.needsAuth || !profile) return Promise.resolve(null)

    const promise = (async () => {
      const next = await get().connectSsh(profile, {
        connectionId: session.connectionId,
        startCwd: session.startCwd,
        groupId: session.groupId,
        title: session.customTitle ? session.title : undefined,
        replaceId: id,
        activate: useLayout.getState().activeGroupId === session.groupId
      })
      if (next) deferredRemoteProfiles.delete(id)
      return next
    })()
    deferredRemoteConnects.set(id, promise)
    void promise.then(
      () => deferredRemoteConnects.delete(id),
      () => deferredRemoteConnects.delete(id)
    )
    return promise
  },

  setDeferredCredentials: (id, credentials) => {
    const current = deferredRemoteProfiles.get(id)
    if (!current) return
    const next: SSHProfile = {
      ...current,
      password: credentials.password || current.password,
      passphrase: credentials.passphrase || current.passphrase,
      jump: encodeJump(
        listJumpHops(current.jump).map((h, i) =>
          i === 0
            ? {
                ...h,
                password: credentials.jumpPassword || h.password,
                passphrase: credentials.jumpPassphrase || h.passphrase
              }
            : h
        )
      )
    }
    deferredRemoteProfiles.set(id, next)
    set((s) => ({
      sessions: s.sessions.map((x) =>
        x.id === id
          ? {
              ...x,
              restoreProfile: next,
              needsAuth: false,
              closed: false,
              status: 'waiting for focus'
            }
          : x
      )
    }))
  },

  addBrowser: (opts) => {
    const id = `browser-${crypto.randomUUID()}`
    const session: Session = {
      id,
      kind: 'browser',
      title: opts?.title ?? (opts?.preview ? 'Preview' : 'Browser'),
      url: opts?.url,
      groupId: opts?.groupId ?? useLayout.getState().activeGroupId,
      agentOwnedBy: opts?.agentOwnedBy,
      firstTabKey: opts?.firstTabKey,
      browserTabs: opts?.browserTabs,
      browserActiveTab: opts?.browserActiveTab,
      preview: opts?.preview
    }
    // The App-level layout sync effect drops this id into the active group's
    // active leaf (same path as addLocal); no pty/ssh is created for it.
    set((s) => ({ sessions: [...s.sessions, session], activeId: id }))
    return id
  },

  cancelSshReconnect: (sessionId) => {
    // The main process owns the timer; we just ask it to cancel and clear the
    // visible status. The session stays in its last-known state (closed if it
    // had dropped).
    window.devterm.ssh.cancelReconnect(sessionId)
    set((s) => ({
      sessions: s.sessions.map((x) =>
        x.id === sessionId && x.status?.startsWith('reconnecting')
          ? { ...x, status: 'reconnect cancelled' }
          : x
      )
    }))
  },

  retrySshReconnect: (sessionId) => {
    window.devterm.ssh.reconnect(sessionId)
  },

  setActive: (id) =>
    set((s) => {
      if (!s.sessions.some((x) => x.id === id)) return s
      // Looking at a session satisfies its attention signal — clear the badge
      // as it becomes active (covers tab clicks and pane mousedown alike).
      const needsClear = s.sessions.some(
        (x) => x.id === id && (x.needsAttention || x.hasUnreadOutput)
      )
      return {
        activeId: id,
        lastActiveId: s.activeId,
        sessions: needsClear
          ? s.sessions.map((x) =>
              x.id === id ? { ...x, needsAttention: false, hasUnreadOutput: false } : x
            )
          : s.sessions
      }
    }),
  setGroup: (id, groupId) =>
    set((s) => {
      const cur = s.sessions.find((x) => x.id === id)
      if (!cur || (cur.groupId ?? null) === groupId) return s
      return {
        sessions: s.sessions.map((x) => (x.id === id ? { ...x, groupId } : x)),
        activeId: id
      }
    }),
  setStatus: (id, status) =>
    set((s) => ({ sessions: s.sessions.map((x) => (x.id === id ? { ...x, status } : x)) })),
  setTitle: (id, title) =>
    set((s) => {
      const cur = s.sessions.find((x) => x.id === id)
      // page-title-updated can fire several times per load; skip no-op writes so
      // we don't re-render the whole pane tree each time (mirrors setCwd's guard).
      if (!cur || cur.title === title) return s
      return { sessions: s.sessions.map((x) => (x.id === id ? { ...x, title } : x)) }
    }),
  setBrowserUrl: (id, url) =>
    set((s) => {
      const cur = s.sessions.find((x) => x.id === id)
      if (!cur || cur.kind !== 'browser' || cur.url === url) return s
      return { sessions: s.sessions.map((x) => (x.id === id ? { ...x, url } : x)) }
    }),
  setBrowserTabs: (id, tabs, activeIndex) =>
    set((s) => {
      const cur = s.sessions.find((x) => x.id === id)
      if (!cur || cur.kind !== 'browser') return s
      const nextIndex = Math.max(0, Math.min(Math.max(0, tabs.length - 1), activeIndex))
      const sameTabs = JSON.stringify(cur.browserTabs ?? []) === JSON.stringify(tabs)
      if (sameTabs && (cur.browserActiveTab ?? 0) === nextIndex) return s
      return {
        sessions: s.sessions.map((x) =>
          x.id === id ? { ...x, browserTabs: tabs, browserActiveTab: nextIndex } : x
        )
      }
    }),
  clearRestoreScrollback: (id) =>
    set((s) => {
      const cur = s.sessions.find((x) => x.id === id)
      if (!cur || cur.restoreScrollback === undefined) return s
      return {
        sessions: s.sessions.map((x) => (x.id === id ? { ...x, restoreScrollback: undefined } : x))
      }
    }),
  setCustomTitle: (id, title) =>
    set((s) => {
      const cur = s.sessions.find((x) => x.id === id)
      if (!cur || (cur.title === title && cur.customTitle)) return s
      return {
        sessions: s.sessions.map((x) => (x.id === id ? { ...x, title, customTitle: true } : x))
      }
    }),
  setCwd: (id, cwd) =>
    set((s) => {
      const cur = s.sessions.find((x) => x.id === id)
      // OSC 7 fires every prompt; skip the state update when cwd is unchanged
      // so we don't re-render the whole tree on each command (was causing lag).
      if (!cur || cur.cwd === cwd) return s
      return { sessions: s.sessions.map((x) => (x.id === id ? { ...x, cwd } : x)) }
    }),
  setCurrentCommand: (id, command) =>
    set((s) => {
      const cur = s.sessions.find((x) => x.id === id)
      if (!cur || cur.currentCommand === command) return s
      return {
        sessions: s.sessions.map((x) => (x.id === id ? { ...x, currentCommand: command } : x))
      }
    }),
  setAgentTask: (id, task, kind) =>
    set((s) => {
      const cur = s.sessions.find((x) => x.id === id)
      if (!cur || (cur.agentTask === task && (kind === undefined || cur.agentKind === kind)))
        return s
      return {
        sessions: s.sessions.map((x) =>
          x.id === id ? { ...x, agentTask: task, agentKind: kind ?? x.agentKind } : x
        )
      }
    }),
  setAgentLaunch: (id, launch) =>
    set((s) => ({
      sessions: s.sessions.map((x) => (x.id === id ? { ...x, agentLaunch: launch } : x))
    })),
  consumeAgentLaunch: (id) => {
    let launch: AgentLaunchRequest | undefined
    set((s) => {
      const cur = s.sessions.find((x) => x.id === id)
      if (!cur?.agentLaunch) return s
      launch = cur.agentLaunch
      return {
        sessions: s.sessions.map((x) => (x.id === id ? { ...x, agentLaunch: undefined } : x))
      }
    })
    return launch
  },
  setAgentUi: (id, patch, opts) => {
    // Always sync UI mode to main (confirm routing + float window lifecycle),
    // even when this renderer has no session record (floating agent window).
    // localOnly: apply a mode that main already broadcast (avoid feedback loop).
    if (patch.mode !== undefined && !opts?.localOnly) {
      window.devterm.agent.setUiMode(id, patch.mode)
    }
    set((s) => {
      const cur = s.sessions.find((x) => x.id === id)
      if (!cur) return s
      // Stopped / cleared: drop placement metadata. Keep agentKind as last-used.
      if (patch.mode === null) {
        return {
          sessions: s.sessions.map((x) =>
            x.id === id
              ? {
                  ...x,
                  agentUiMode: undefined,
                  agentPtyId: undefined,
                  agentPolicyMode: undefined,
                  agentTask: undefined,
                  agentBridgeState: undefined,
                  agentExited: undefined,
                  agentStartedAt: undefined
                }
              : x
          )
        }
      }
      const nextMode = patch.mode ?? cur.agentUiMode
      const nextPty =
        patch.ptyId === null ? undefined : patch.ptyId !== undefined ? patch.ptyId : cur.agentPtyId
      const nextKind = patch.kind ?? cur.agentKind
      const nextPolicy = patch.policyMode ?? cur.agentPolicyMode
      if (
        cur.agentUiMode === nextMode &&
        cur.agentPtyId === nextPty &&
        cur.agentKind === nextKind &&
        cur.agentPolicyMode === nextPolicy
      ) {
        return s
      }
      return {
        sessions: s.sessions.map((x) =>
          x.id === id
            ? {
                ...x,
                agentUiMode: nextMode,
                agentPtyId: nextPty,
                agentKind: nextKind,
                agentPolicyMode: nextPolicy,
                agentStartedAt: cur.agentStartedAt ?? Date.now(),
                // A fresh open/reattach clears a prior exited marker and start error.
                agentExited: patch.ptyId !== undefined ? false : x.agentExited,
                agentStartError: patch.ptyId !== undefined ? undefined : x.agentStartError
              }
            : x
        )
      }
    })
  },
  markClosed: (id) => {
    // A transport close is transient while the main process auto-reconnects.
    // Keep the status subscription alive so this session can observe the
    // following `reconnecting` and `reconnected` events. Explicit tab close is
    // the owner of listener disposal.
    set((s) => ({
      sessions: s.sessions.map((x) =>
        x.id === id
          ? {
              ...x,
              closed: true,
              status: 'closed',
              currentCommand: undefined,
              processRunning: false,
              agentTask: undefined
            }
          : x
      )
    }))
  },

  setAgentBridgeState: (id, state) =>
    set((s) => {
      const cur = s.sessions.find((x) => x.id === id)
      // Skip the update if the value is unchanged — the bridge status pushes
      // every state transition, and a no-op write would still re-render the
      // tab strip and any consumer of the session record.
      if (!cur || cur.agentBridgeState === state) return s
      return {
        sessions: s.sessions.map((x) => (x.id === id ? { ...x, agentBridgeState: state } : x))
      }
    }),

  setAgentPendingApproval: (id, pending) =>
    set((s) => {
      const cur = s.sessions.find((x) => x.id === id)
      if (!cur || cur.agentPendingApproval === pending) return s
      return {
        sessions: s.sessions.map((x) => (x.id === id ? { ...x, agentPendingApproval: pending } : x))
      }
    }),

  setNeedsAttention: (id, pending) =>
    set((s) => {
      const cur = s.sessions.find((x) => x.id === id)
      if (!cur || !!cur.needsAttention === pending) return s
      return {
        sessions: s.sessions.map((x) => (x.id === id ? { ...x, needsAttention: pending } : x))
      }
    }),

  setHasUnreadOutput: (id, unread) =>
    set((s) => {
      const cur = s.sessions.find((x) => x.id === id)
      if (!cur || !!cur.hasUnreadOutput === unread) return s
      return {
        sessions: s.sessions.map((x) => (x.id === id ? { ...x, hasUnreadOutput: unread } : x))
      }
    }),

  setProcessRunning: (id, running) =>
    set((s) => {
      const cur = s.sessions.find((x) => x.id === id)
      if (!cur || !!cur.processRunning === running) return s
      return {
        sessions: s.sessions.map((x) => (x.id === id ? { ...x, processRunning: running } : x))
      }
    }),

  setAgentExited: (id, exited) =>
    set((s) => {
      const cur = s.sessions.find((x) => x.id === id)
      if (!cur || !!cur.agentExited === exited) return s
      return {
        sessions: s.sessions.map((x) => (x.id === id ? { ...x, agentExited: exited } : x))
      }
    }),

  setAgentStartError: (id, message) =>
    set((s) => {
      const cur = s.sessions.find((x) => x.id === id)
      const next = message?.trim() ? message.trim().slice(0, 400) : undefined
      if (!cur || cur.agentStartError === next) return s
      return {
        sessions: s.sessions.map((x) => (x.id === id ? { ...x, agentStartError: next } : x))
      }
    }),

  bumpAgentRestart: (id) =>
    set((s) => ({
      sessions: s.sessions.map((x) =>
        x.id === id ? { ...x, agentRestartNonce: (x.agentRestartNonce ?? 0) + 1 } : x
      )
    })),

  setExitCode: (id, code) =>
    set((s) => {
      const cur = s.sessions.find((x) => x.id === id)
      if (!cur || cur.exitCode === code) return s
      return {
        sessions: s.sessions.map((x) => (x.id === id ? { ...x, exitCode: code } : x))
      }
    }),

  close: (id) => {
    const s = get().sessions.find((x) => x.id === id)
    deferredRemoteProfiles.delete(id)
    if (s?.kind === 'local' || (s?.kind === 'remote' && !id.startsWith('pending-'))) {
      statusDisposers.get(id)?.()
      statusDisposers.delete(id)
      // Stop an agent + floating window before dropping the session so a
      // delegated local tab cannot leave its bridge running after close.
      window.devterm.agent.close(id)
      window.devterm.agent.closeWindow(id)
    }
    if (s?.kind === 'remote' && !id.startsWith('pending-')) {
      window.devterm.ssh.disconnect(id)
    }
    if (s?.preview?.serveId) {
      void window.devterm.preview.stopServe(s.preview.serveId).catch(() => undefined)
    }
    set((st) => {
      const remaining = st.sessions.filter((x) => x.id !== id)
      const activeId =
        st.activeId === id
          ? remaining.some((x) => x.id === st.lastActiveId)
            ? st.lastActiveId
            : remaining.length
              ? remaining[0].id
              : null
          : st.activeId
      return {
        sessions: remaining,
        activeId,
        lastActiveId: st.lastActiveId === id ? null : st.lastActiveId
      }
    })
  }
}))
