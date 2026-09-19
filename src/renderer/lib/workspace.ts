import type { Workspace, WorkspaceItem, WorkspaceLayoutNode, SavedConnection } from '@shared/types'
import type { Session } from '../store/sessions'
import {
  useLayout,
  DEFAULT_GROUP,
  groupActiveSession,
  type LayoutNode,
  type LayoutSnapshot
} from '../store/layout'
import { useSessions } from '../store/sessions'
import { waitForRemoteConnectStagger } from './remote-connect'

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

const newItemId = () => `wi-${crypto.randomUUID()}`

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

export interface WorkspaceConnectProgress {
  groupId: string
  total: number
  ready: number
  failed: number
  errors: string[]
}

export interface WorkspaceLaunchOptions {
  recordLaunch?: boolean
  /** Keep this group in the background (used by boot-time auto-launch). */
  activate?: boolean
  onProgress?: (progress: WorkspaceConnectProgress) => void
  onSettled?: (progress: WorkspaceConnectProgress) => void
}

interface LazyWorkspaceGroup {
  groupId: string
  sessionMap: Map<string, string>
  remoteItems: WorkspaceItem[]
  failures: string[]
  ready: Set<string>
  connectPromise?: Promise<void>
  onProgress?: (progress: WorkspaceConnectProgress) => void
  onSettled?: (progress: WorkspaceConnectProgress) => void
}

const lazyWorkspaceGroups = new Map<string, LazyWorkspaceGroup>()

function workspaceProgress(record: LazyWorkspaceGroup): WorkspaceConnectProgress {
  return {
    groupId: record.groupId,
    total: record.remoteItems.length,
    ready: record.ready.size,
    failed: record.failures.length,
    errors: [...record.failures]
  }
}

function emitWorkspaceProgress(record: LazyWorkspaceGroup): void {
  record.onProgress?.(workspaceProgress(record))
}

/** Connect a launched workspace's painted remote tabs without a same-tick burst. */
export function activateWorkspaceGroup(groupId: string): Promise<void> {
  const record = lazyWorkspaceGroups.get(groupId)
  if (!record) return Promise.resolve()
  if (record.connectPromise) return record.connectPromise
  record.connectPromise = (async () => {
    const jobs = record.remoteItems.map(async (it, index) => {
      const pendingId = record.sessionMap.get(it.id)
      if (!pendingId) return
      await waitForRemoteConnectStagger(index)
      try {
        const sid = await useSessions.getState().connectDeferred(pendingId)
        if (sid) {
          record.sessionMap.set(it.id, sid)
          record.ready.add(it.id)
        } else {
          const status = useSessions.getState().sessions.find((s) => s.id === pendingId)?.status
          record.failures.push(
            `${it.title ?? `Remote cell ${index + 1}`}: ${status ?? 'connection failed'}`
          )
        }
      } catch (e) {
        record.failures.push(
          `${it.title ?? `Remote cell ${index + 1}`}: ${e instanceof Error ? e.message : String(e)}`
        )
      }
      emitWorkspaceProgress(record)
    })
    await Promise.all(jobs)
    const progress = workspaceProgress(record)
    record.onSettled?.(progress)
  })()
  return record.connectPromise
}

/**
 * Open every terminal in a workspace into a fresh group, then restore the
 * saved split layout (if any). Used by WorkspacesManager's Launch button
 * and by App's startup auto-launch. Returns the new group id and the map
 * of workspace-item id → session id (pending ids are updated in place as
 * deferred remotes connect) for callers that need it.
 *
 * `recordLaunch` (default false) bumps the server-side launchCount +
 * lastLaunchedAt; callers that want to count this as a "real" launch
 * (e.g. the Launch button, not the auto-launch on app boot) opt in.
 */
export async function launchWorkspaceIntoGroup(
  ws: Workspace,
  conns: SavedConnection[],
  opts: WorkspaceLaunchOptions = {}
): Promise<{ groupId: string; sessionMap: Map<string, string> }> {
  const { addLocal, addDeferredRemote } = useSessions.getState()
  const groupId = `ws-${ws.id}-${Date.now()}`
  const wasActiveGroup = useLayout.getState().activeGroupId
  const layout = useLayout.getState()
  layout.ensureGroup(groupId, ws.name)
  layout.flagGroupLaunched(groupId, ws.id)

  const sessionMap = new Map<string, string>()
  const failures: string[] = []
  const remoteItems = ws.items.filter((it) => it.kind === 'remote')
  for (const it of ws.items) {
    if (it.kind === 'local') {
      sessionMap.set(it.id, addLocal({ cwd: it.cwd, groupId, title: it.title }))
      continue
    }
    const c = conns.find((x) => x.id === it.connectionId)
    if (!c) {
      failures.push(`${it.title ?? 'Remote host'}: saved connection not found`)
      continue
    }
    const { id: _id, name: connectionName, ...profile } = c
    sessionMap.set(
      it.id,
      addDeferredRemote({
        profile,
        connectionId: it.connectionId,
        startCwd: it.cwd,
        groupId,
        title: it.title ?? connectionName
      })
    )
  }

  const record: LazyWorkspaceGroup = {
    groupId,
    sessionMap,
    remoteItems,
    failures,
    ready: new Set(),
    onProgress: opts.onProgress,
    onSettled: opts.onSettled
  }
  lazyWorkspaceGroups.set(groupId, record)

  // Put the full chrome/layout on screen while remotes are still pending.
  useLayout
    .getState()
    .sync(useSessions.getState().sessions.map((s) => ({ id: s.id, groupId: s.groupId })))
  const snap = ws.layout ? toLiveSnapshot(ws.layout, sessionMap) : null
  if (snap) useLayout.getState().restoreGroup(groupId, ws.name, snap, opts.activate !== false)
  else if (opts.activate !== false) useLayout.getState().setActiveGroup(groupId)
  if (opts.activate === false) useLayout.getState().setActiveGroup(wasActiveGroup)
  if (opts.activate !== false) {
    const activeSession = groupActiveSession(
      useLayout.getState().groups.find((g) => g.id === groupId)
    )
    if (activeSession) useSessions.getState().setActive(activeSession)
  }

  emitWorkspaceProgress(record)
  if (opts.activate !== false) void activateWorkspaceGroup(groupId)

  if (opts.recordLaunch) {
    void window.devterm.workspaces.recordLaunch(ws.id).catch(() => undefined)
  }
  return { groupId, sessionMap }
}
