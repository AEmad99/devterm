import type { Workspace, WorkspaceItem, WorkspaceLayoutNode, SavedConnection } from '@shared/types'
import type { Session } from '../store/sessions'
import { useLayout, DEFAULT_GROUP, type LayoutNode, type LayoutSnapshot } from '../store/layout'
import { useSessions } from '../store/sessions'

/**
 * Pure helpers for turning live terminals into a saved workspace and back.
 *
 * A workspace is a snapshot of the terminals in one group: which local shells +
 * saved SSH connections are open, the directory each was sitting in, and how
 * they're split/tiled. Capture happens from the Terminals view (the group bar's
 * "Save as workspace" button); launch replays it from the Workspaces tab. Both
 * local and remote terminals are captured — only ad-hoc SSH sessions with no
 * saved connection are skipped (we have no way to reconnect them).
 */

let itemSeq = 0
const newItemId = () => `wi-${Date.now()}-${++itemSeq}`

/** Map a live layout tree → an item-id snapshot, keeping only sessions present in `items`. */
function snapshotNode(
  n: LayoutNode | null,
  items: Map<string, string>
): WorkspaceLayoutNode | null {
  if (!n) return null
  if (n.type === 'leaf') {
    const tabs: string[] = []
    for (const sid of n.tabs) {
      const iid = items.get(sid)
      if (iid && !tabs.includes(iid)) tabs.push(iid)
    }
    if (!tabs.length) return null
    const active = (n.active && items.get(n.active)) || tabs[tabs.length - 1]
    return { type: 'leaf', tabs, active }
  }
  const kept: WorkspaceLayoutNode[] = []
  const keptSizes: number[] = []
  n.children.forEach((c, i) => {
    const r = snapshotNode(c, items)
    if (r) {
      kept.push(r)
      keptSizes.push(n.sizes[i] ?? 1)
    }
  })
  if (!kept.length) return null
  if (kept.length === 1) return kept[0]
  const total = keptSizes.reduce((a, b) => a + b, 0) || kept.length
  return { type: 'split', dir: n.dir, sizes: keptSizes.map((s) => s / total), children: kept }
}

/** Map a saved item-id snapshot → a live session-id snapshot, dropping items that didn't open. */
export function toLiveSnapshot(
  n: WorkspaceLayoutNode,
  map: Map<string, string>
): LayoutSnapshot | null {
  if (n.type === 'leaf') {
    const tabs: string[] = []
    for (const iid of n.tabs) {
      const sid = map.get(iid)
      if (sid && !tabs.includes(sid)) tabs.push(sid)
    }
    if (!tabs.length) return null
    const active = (n.active && map.get(n.active)) || tabs[tabs.length - 1]
    return { type: 'leaf', tabs, active }
  }
  const kept: LayoutSnapshot[] = []
  const keptSizes: number[] = []
  n.children.forEach((c, i) => {
    const r = toLiveSnapshot(c, map)
    if (r) {
      kept.push(r)
      keptSizes.push(n.sizes[i] ?? 1)
    }
  })
  if (!kept.length) return null
  if (kept.length === 1) return kept[0]
  const total = keptSizes.reduce((a, b) => a + b, 0) || kept.length
  return { type: 'split', dir: n.dir, sizes: keptSizes.map((s) => s / total), children: kept }
}

/**
 * The terminals in `groupId` we can recreate: every open local shell, plus
 * remote sessions linked to a saved connection. Ad-hoc SSH (no connectionId)
 * can't be reopened. Browser panes are ephemeral and intentionally excluded (the
 * whitelist below admits only local/remote). Scoped to one group so saving
 * doesn't sweep in terminals from other groups.
 */
export function capturableSessions(sessions: Session[], groupId: string): Session[] {
  return sessions.filter(
    (s) =>
      (s.groupId || DEFAULT_GROUP) === groupId &&
      !s.closed &&
      !s.id.startsWith('pending-') &&
      (s.kind === 'local' || (s.kind === 'remote' && s.connectionId))
  )
}

/** Build the `{items, layout}` payload for a workspace from a group's live terminals. */
export function captureWorkspace(
  sessions: Session[],
  groupId: string
): Pick<Workspace, 'items' | 'layout'> {
  const capturable = capturableSessions(sessions, groupId)

  // One workspace item per open terminal, plus a session-id → item-id map so the
  // live split layout can be re-expressed in item ids.
  const sidToItem = new Map<string, string>()
  const items: WorkspaceItem[] = capturable.map((s) => {
    const id = newItemId()
    sidToItem.set(s.id, id)
    return {
      id,
      // capturableSessions excludes browser panes, so this is always local/remote.
      kind: s.kind === 'remote' ? 'remote' : 'local',
      connectionId: s.kind === 'remote' ? s.connectionId : undefined,
      cwd: s.cwd,
      title: s.title
    }
  })

  const root = useLayout.getState().groups.find((g) => g.id === groupId)?.root ?? null
  const layout = snapshotNode(root, sidToItem)
  return { items, layout }
}

/**
 * Open every terminal in a workspace into a fresh group, then restore the
 * saved split layout (if any). Used by WorkspacesManager's Launch button
 * and by App's startup auto-launch. Returns the new group id and the map
 * of workspace-item id → live session id for callers that need it.
 *
 * `recordLaunch` (default false) bumps the server-side launchCount +
 * lastLaunchedAt; callers that want to count this as a "real" launch
 * (e.g. the Launch button, not the auto-launch on app boot) opt in.
 */
export async function launchWorkspaceIntoGroup(
  ws: Workspace,
  conns: SavedConnection[],
  opts: { recordLaunch?: boolean } = {}
): Promise<{ groupId: string; sessionMap: Map<string, string> }> {
  const { addLocal, connectSsh } = useSessions.getState()
  const groupId = `ws-${ws.id}-${Date.now()}`
  const layout = useLayout.getState()
  layout.ensureGroup(groupId, ws.name)
  layout.flagGroupLaunched(groupId, ws.id)

  const sessionMap = new Map<string, string>()
  await Promise.all(
    ws.items.map(async (it) => {
      if (it.kind === 'local') {
        sessionMap.set(it.id, addLocal({ cwd: it.cwd, groupId }))
        return
      }
      const c = conns.find((x) => x.id === it.connectionId)
      if (!c) return
      const { id: _id, name: _n, ...profile } = c
      const sid = await connectSsh(profile, {
        connectionId: it.connectionId,
        startCwd: it.cwd,
        groupId
      })
      if (sid) sessionMap.set(it.id, sid)
    })
  )

  const snap = ws.layout ? toLiveSnapshot(ws.layout, sessionMap) : null
  // Defer the layout restore so App's layout-sync effect has a chance to
  // stack the new sessions into the group first.
  await new Promise<void>((resolve) => setTimeout(resolve, 80))
  const layout2 = useLayout.getState()
  if (snap) layout2.restoreGroup(groupId, ws.name, snap)
  else layout2.setActiveGroup(groupId)

  if (opts.recordLaunch) {
    void window.devterm.workspaces.recordLaunch(ws.id).catch(() => undefined)
  }
  return { groupId, sessionMap }
}
