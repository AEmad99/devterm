import { create } from 'zustand'
import type { HostContext, SSHProfile } from '@shared/types'
import { useLayout } from './layout'

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
}

interface SessionState {
  sessions: Session[]
  activeId: string | null
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
  setCwd: (id: string, cwd: string) => void
  markClosed: (id: string) => void
  close: (id: string) => void
}

export const useSessions = create<SessionState>((set, get) => ({
  sessions: [],
  activeId: null,

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
          groupId: meta?.groupId ?? useLayout.getState().activeGroupId
        }
      ],
      activeId: tempId
    }))
    try {
      const { sessionId, context } = await window.devterm.ssh.connect(profile)
      // Subscribe to non-fatal status events for the real session id.
      window.devterm.ssh.onStatus(sessionId, (st) => {
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
      set((s) => ({
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
        activeId: sessionId
      }))
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

  setActive: (id) => set({ activeId: id }),
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
  setCwd: (id, cwd) =>
    set((s) => {
      const cur = s.sessions.find((x) => x.id === id)
      // OSC 7 fires every prompt; skip the state update when cwd is unchanged
      // so we don't re-render the whole tree on each command (was causing lag).
      if (!cur || cur.cwd === cwd) return s
      return { sessions: s.sessions.map((x) => (x.id === id ? { ...x, cwd } : x)) }
    }),
  markClosed: (id) =>
    set((s) => ({
      sessions: s.sessions.map((x) => (x.id === id ? { ...x, closed: true, status: 'closed' } : x))
    })),

  close: (id) => {
    const s = get().sessions.find((x) => x.id === id)
    if (s?.kind === 'remote' && !id.startsWith('pending-')) window.devterm.ssh.disconnect(id)
    set((st) => {
      const remaining = st.sessions.filter((x) => x.id !== id)
      const activeId =
        st.activeId === id
          ? remaining.length
            ? remaining[remaining.length - 1].id
            : null
          : st.activeId
      return { sessions: remaining, activeId }
    })
  }
}))
