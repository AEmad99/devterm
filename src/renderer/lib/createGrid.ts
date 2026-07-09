import { useSessions } from '../store/sessions'
import { useLayout } from '../store/layout'
import { buildGridSnapshot, clampGridSpec, gridCellCount, validateGridSpec } from './grid'
import { broadcastToSessions } from './input'
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
    // Local TerminalViews need one render frame to mount and register their input
    // sender; retry any failures once after a short delay. Remote sessions are
    // reached immediately through ssh:input.
    const runBroadcast = () => {
      const { failed } = broadcastToSessions(ids, req.broadcast!.command, req.broadcast!.execute)
      if (failed.length) {
        setTimeout(() => {
          broadcastToSessions(failed, req.broadcast!.command, req.broadcast!.execute)
        }, 400)
      }
      setTimeout(() => focusTerminal(ids[0]), 0)
    }
    setTimeout(runBroadcast, 300)
  }

  return { groupId, sessionIds: ids, requested: count, created: ids.length, errors: [] }
}
