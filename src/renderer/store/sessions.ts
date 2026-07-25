import { create } from 'zustand'
import type { AgentBridgeState, AgentKind, HostContext, SSHProfile } from '@shared/types'
import { useLayout } from './layout'

const statusDisposers = new Map<string, () => void>()

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
  /**
   * Initial working directory to open the shell in (best-effort), set when a
   * session is launched from a saved workspace. Consumed once by TerminalView on
   * mount; live cwd afterwards is tracked separately in `cwd`.
   */
  startCwd?: string
  /**
   * Top-level terminal group this session belongs to (a launched workspace, or
   * the default ungrouped group). Drives the group tabs; see store/layout.ts.
   */
  groupId?: string
  /** Browser panes only: initial URL to load on mount (consumed once, like startCwd). */
  url?: string
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
  /** True when new output has arrived while this session was not active. */
  hasUnreadOutput?: boolean
  /** True when a command is running in this session (set on Enter, cleared on prompt/exit). */
  processRunning?: boolean
  /** Last shell exit code, if known. null for remote closes without a code. */
  exitCode?: number | null
}

interface SessionState {
  sessions: Session[]
  activeId: string | null
  lastActiveId: string | null
  /**
   * Open a local shell; returns the new session id. `cwd` sets its starting
   * directory, `groupId` its terminal group (defaults to the active group).
   */
  addLocal: (opts?: { cwd?: string; groupId?: string }) => string
  /** Connect a remote session; resolves to the real session id (or null on failure). */
  connectSsh: (
    profile: SSHProfile,
    meta?: { connectionId?: string; startCwd?: string; groupId?: string }
  ) => Promise<string | null>
  /** Cancel any in-flight auto-reconnect loop for the given session. */
  cancelSshReconnect: (sessionId: string) => void
  /** Open an in-app browser pane; returns the new session id. Spawns no pty/ssh. */
  addBrowser: (opts?: { url?: string; groupId?: string }) => string
  setActive: (id: string) => void
  /** Move a session into another terminal group (the layout sync reconciles trees). */
  setGroup: (id: string, groupId: string) => void
  setStatus: (id: string, status: string) => void
  /** Update a session's tab title (browser panes push the page title here). */
  setTitle: (id: string, title: string) => void
  /** Set a user-chosen tab title and mark it custom so dynamic labels don't overwrite it. */
  setCustomTitle: (id: string, title: string) => void
  setCwd: (id: string, cwd: string) => void
  /** Update the command currently running in this terminal (set on Enter, cleared on prompt). */
  setCurrentCommand: (id: string, command: string | undefined) => void
  /** Set the current agent task surfaced from bridge activity. */
  setAgentTask: (id: string, task: string | undefined, kind?: AgentKind) => void
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
    const id = `local-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    const session: Session = {
      id,
      kind: 'local',
      title: `Local ${n}`,
      localNum: n,
      startCwd: opts?.cwd,
      // Seed live cwd so the file explorer opens on the launch directory
      // before the first OSC 7 prompt reports; OSC 7 overwrites this later.
      cwd: opts?.cwd,
      groupId: opts?.groupId ?? useLayout.getState().activeGroupId,
      context: { kind: 'local', os: 'unknown', detail: '', hostname: '' }
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
    const tempId = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    set((s) => ({
      sessions: [
        ...s.sessions,
        {
          id: tempId,
          kind: 'remote',
          title: `${profile.username}@${profile.host}`,
          status: 'connecting…',
          connectionId: meta?.connectionId,
          startCwd: meta?.startCwd,
          // Provisional cwd for workspace restore / reconnect; OSC 7 confirms.
          cwd: meta?.startCwd,
          groupId: meta?.groupId ?? useLayout.getState().activeGroupId
        }
      ],
      activeId: tempId
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
        else if (st.type === 'reconnected')
          get().setStatus(sessionId, `reconnected (attempt ${st.attempt})`)
        else if (st.type === 'reconnect-failed')
          get().setStatus(sessionId, `reconnect failed after ${st.attempts} attempts: ${st.reason}`)
      })
      statusDisposers.set(sessionId, dispose)
      set((s) => {
        const stillPending = s.sessions.some((x) => x.id === tempId)
        const activeId = stillPending
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
                  title: `${profile.username}@${context.hostname || profile.host}`,
                  context,
                  status: `connected · ${context.os}`
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
          x.id === tempId ? { ...x, status: `failed: ${(e as Error).message}`, closed: true } : x
        )
      }))
      return null
    }
  },

  addBrowser: (opts) => {
    const id = `browser-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    const session: Session = {
      id,
      kind: 'browser',
      title: 'Browser',
      url: opts?.url,
      groupId: opts?.groupId ?? useLayout.getState().activeGroupId
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
  markClosed: (id) => {
    statusDisposers.get(id)?.()
    statusDisposers.delete(id)
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
    if (s?.kind === 'remote' && !id.startsWith('pending-')) {
      statusDisposers.get(id)?.()
      statusDisposers.delete(id)
      window.devterm.ssh.disconnect(id)
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
