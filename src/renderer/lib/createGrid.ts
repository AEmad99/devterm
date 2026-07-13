import { useSessions } from '../store/sessions'
import { useLayout } from '../store/layout'
import { buildGridSnapshot, clampGridSpec, gridCellCount, validateGridSpec } from './grid'
import { sendToSession } from './input'
import { focusTerminal } from './terms'

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
 * V1: local shells only. Remote grids are deferred to a later PR.
 */
export function createTerminalGrid(req: CreateGridRequest): CreateGridResult {
  const err = validateGridSpec(req)
  if (err) throw new Error(err)

  const { rows, cols } = clampGridSpec(req)
  const count = gridCellCount({ rows, cols })
  const name = req.groupName ?? `${rows}×${cols}`

  if (req.kind === 'remote') {
    throw new Error('Remote terminal grids are not supported yet')
  }
  if (req.connectionId) {
    throw new Error('connectionId is only used for remote grids')
  }

  const layout = useLayout.getState()
  const groupId = layout.createGroup(name)

  const ids: string[] = []
  for (let i = 0; i < count; i++) {
    ids.push(useSessions.getState().addLocal({ cwd: req.cwd, groupId }))
  }

  const snap = buildGridSnapshot(ids, rows, cols)
  useLayout.getState().restoreGroup(groupId, name, snap)
  useSessions.getState().setActive(ids[0])

  if (req.broadcast?.command.trim()) {
    // TerminalViews mount asynchronously after the layout snapshot is restored,
    // and their local PTYs are created async after that. Poll until every cell's
    // input sender is wired, retrying only the cells that are not ready yet, so
    // the command is sent exactly once per terminal. Cap total wait at 5s.
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
        void window.devterm.history.record(command, 'local')
      }
      if (attempts >= maxAttempts) {
        window.clearInterval(timer)
        setTimeout(() => focusTerminal(ids[0]), 0)
      }
    }, 100)
  }

  return { groupId, sessionIds: ids, requested: count, created: ids.length, errors: [] }
}
