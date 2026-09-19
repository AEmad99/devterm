import { useSessions } from '../store/sessions'
import { useLayout } from '../store/layout'
import {
  buildGridSnapshot,
  clampGridSpec,
  gridCellCount,
  packIdsAsGrid,
  validateGridSpec
} from './grid'
import { sendToSession } from './input'
import { focusTerminal } from './terms'
import { waitForRemoteConnectStagger } from './remote-connect'

export type GridCellKind = 'local' | 'remote'

export type CreateGridBroadcast = {
  command: string
  /** When true the command is submitted with a carriage return; otherwise it is only typed. */
  execute: boolean
}

export type CreateGridRequest = {
  rows: number
  cols: number
  kind: GridCellKind
  /** Required when kind === 'remote' (saved connection only). V1 local only. */
  connectionId?: string
  /** Optional shared start directory for callers/tests. V1 modal does not expose this. */
  cwd?: string
  /**
   * Default true. V1 always creates a new group.
   * Future: in-place only when destination is empty DEFAULT_GROUP.
   */
  newGroup?: boolean
  groupName?: string
  /** Optional command to broadcast to every created cell after the grid is ready. */
  broadcast?: CreateGridBroadcast
  /** Called once the broadcast finished (or timed out) with delivery counts. */
  onBroadcast?: (result: { sent: number; total: number; timedOut: boolean }) => void
  /**
   * Remote grids finish asynchronously (one SSH connect per cell). When set,
   * called once all cells have settled with the final result — including any
   * per-cell failures in `errors`. Local grids never call this (their result
   * is the synchronous return value).
   */
  onSettled?: (result: CreateGridResult) => void
  /** Optional live progress for remote cell connection. */
  onProgress?: (result: {
    groupId: string
    completed: number
    requested: number
    created: number
    errors: string[]
  }) => void
}

export type CreateGridResult = {
  groupId: string
  sessionIds: string[]
  requested: number
  created: number
  /** Human-readable failure lines for modal banner / notice (SSH). */
  errors: string[]
}

/**
 * Create an N×M grid of terminals in a new group.
 * Local: one PTY per cell.
 * Remote (SSH): one ssh2 client + shell channel per cell (independent
 * connections — the most resilient model; a single disconnect doesn't
 * knock out the whole grid). Each cell must resolve the saved connection
 * up front; if any cells fail, the rest still open. Local failures are in the
 * returned `errors`; remote failures arrive via `onSettled` once cells settle.
 */
export function createTerminalGrid(req: CreateGridRequest): CreateGridResult {
  const err = validateGridSpec(req)
  if (err) throw new Error(err)

  if (req.kind === 'remote' && !req.connectionId) {
    throw new Error('Remote grids require a saved connectionId')
  }
  if (req.kind === 'local' && req.connectionId) {
    throw new Error('connectionId is only used for remote grids')
  }

  const { rows, cols } = clampGridSpec(req)
  const count = gridCellCount({ rows, cols })
  const name = req.groupName ?? `${rows}×${cols}`

  const layout = useLayout.getState()
  const groupId = layout.createGroup(name)

  const ids: string[] = []
  const errors: string[] = []
  let settledIds: string[] = []

  if (req.kind === 'local') {
    for (let i = 0; i < count; i++) {
      ids.push(useSessions.getState().addLocal({ cwd: req.cwd, groupId }))
    }
  } else {
    // Remote: paint every cell first, then start one deferred SSH connection
    // every 300ms. This keeps the grid chrome useful immediately and avoids
    // creating all of its ssh2 clients in one renderer tick.
    void (async () => {
      const conns = await window.devterm.connections.list()
      const conn = conns.find((c) => c.id === req.connectionId)
      if (!conn) {
        errors.push(`Saved connection not found: ${req.connectionId}`)
        return
      }
      const { id: _id, name: _name, ...profile } = conn
      const liveIdsByIndex: Array<string | undefined> = Array.from({ length: count })
      for (let i = 0; i < count; i++) {
        ids.push(
          useSessions.getState().addDeferredRemote({
            profile,
            connectionId: conn.id,
            groupId,
            title: _name
          })
        )
      }
      useLayout
        .getState()
        .sync(useSessions.getState().sessions.map((s) => ({ id: s.id, groupId: s.groupId })))
      const initial = packIdsAsGrid(ids, cols)
      if (initial) {
        useLayout.getState().restoreGroup(groupId, name, initial)
        useSessions.getState().setActive(ids[0])
      }
      req.onProgress?.({
        groupId,
        completed: 0,
        requested: count,
        created: 0,
        errors: [...errors]
      })

      const jobs = ids.map(async (pendingId, index) => {
        await waitForRemoteConnectStagger(index)
        try {
          const newId = await useSessions.getState().connectDeferred(pendingId)
          if (newId) {
            liveIdsByIndex[index] = newId
          } else {
            const status = useSessions.getState().sessions.find((s) => s.id === pendingId)?.status
            errors.push(`Cell ${index + 1}/${count}: ${status ?? 'connection failed'}`)
          }
        } catch (e) {
          errors.push(`Cell ${index + 1}/${count}: ${e instanceof Error ? e.message : String(e)}`)
        }
        req.onProgress?.({
          groupId,
          completed: index + 1,
          requested: count,
          created: liveIdsByIndex.filter((id): id is string => !!id).length,
          errors: [...errors]
        })
      })
      await Promise.all(jobs)
      const liveIds = liveIdsByIndex.filter((id): id is string => !!id)

      // Re-pack surviving cells after all replacements have settled. Failed
      // deferred cells remain in their painted slots so the operator can retry
      // them instead of silently losing the grid tab.
      const finalIds = ids
        .map((pendingId, index) => liveIdsByIndex[index] ?? pendingId)
        .filter((id) => useSessions.getState().sessions.some((s) => s.id === id))
      if (finalIds.length > 0) {
        const snap = packIdsAsGrid(finalIds, cols)
        if (snap) {
          const activate = useLayout.getState().activeGroupId === groupId
          useLayout.getState().restoreGroup(groupId, name, snap, activate)
          if (activate) useSessions.getState().setActive(finalIds[0])
          if (liveIds.length > 0) maybeBroadcast(liveIds, req, 'remote')
        }
      }
      settledIds = [...liveIds]
      return liveIds
    })()
      .catch((e) => {
        errors.push(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        req.onSettled?.({
          groupId,
          sessionIds: [...settledIds],
          requested: count,
          created: settledIds.length,
          errors: [...errors]
        })
      })
  }

  // Local grids are fully allocated synchronously, so this is the final
  // snapshot. Remote grids return painted pending ids immediately — their
  // layout is packed again by the async path once SSH cells settle.
  if (req.kind === 'local' && ids.length > 0) {
    const snap = buildGridSnapshot(ids, rows, cols)
    useLayout.getState().restoreGroup(groupId, name, snap)
    useSessions.getState().setActive(ids[0])
    maybeBroadcast(ids, req, 'local')
  }

  return { groupId, sessionIds: ids, requested: count, created: ids.length, errors: [...errors] }
}

/**
 * Poll the cell's input sender until it's wired, then send the broadcast
 * command exactly once per terminal. Used by both local and remote grids.
 * History is recorded once (not per cell). Total wait capped at 5s.
 */
function maybeBroadcast(ids: string[], req: CreateGridRequest, scope: 'local' | 'remote'): void {
  if (!req.broadcast?.command.trim() || ids.length === 0) return
  const command = req.broadcast.command
  const execute = req.broadcast.execute
  const data = execute ? command + '\r' : command
  const sent = new Set<string>()
  let historyRecorded = false
  let attempts = 0
  const maxAttempts = 50 // 50 * 100ms = 5s
  const timer = window.setInterval(() => {
    attempts++
    const pending = ids.filter((id) => !sent.has(id))
    if (pending.length === 0) {
      window.clearInterval(timer)
      req.onBroadcast?.({ sent: sent.size, total: ids.length, timedOut: false })
      setTimeout(() => focusTerminal(ids[0]), 0)
      return
    }
    for (const id of pending) {
      if (sendToSession(id, data)) {
        sent.add(id)
      }
    }
    if (execute && command.trim() && sent.size > 0 && !historyRecorded) {
      historyRecorded = true
      void window.devterm.history.record(command, scope)
    }
    if (attempts >= maxAttempts) {
      window.clearInterval(timer)
      req.onBroadcast?.({ sent: sent.size, total: ids.length, timedOut: true })
      setTimeout(() => focusTerminal(ids[0]), 0)
    }
  }, 100)
}
