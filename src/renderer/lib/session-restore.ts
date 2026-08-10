import type {
  SavedConnection,
  SessionRestoreGroup,
  SessionRestoreItem,
  SessionRestoreSnapshot,
  Workspace,
  WorkspaceLayoutNode
} from '@shared/types'
import { useLayout, DEFAULT_GROUP, type LayoutNode } from '../store/layout'
import { useSessions, type Session } from '../store/sessions'
import { launchWorkspaceIntoGroup, toLiveSnapshot } from './workspace'

let itemSeq = 0
const newItemId = () => `sr-${Date.now()}-${++itemSeq}`

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

/** Sessions we can recreate after a restart (no ad-hoc SSH, no browsers). */
export function restorableSessions(sessions: Session[], groupId: string): Session[] {
  return sessions.filter(
    (s) =>
      (s.groupId || DEFAULT_GROUP) === groupId &&
      !s.closed &&
      !s.id.startsWith('pending-') &&
      (s.kind === 'local' || (s.kind === 'remote' && !!s.connectionId))
  )
}

/** Build a snapshot of every non-empty group for persistence. */
export function captureSessionRestoreSnapshot(
  sessions: Session[] = useSessions.getState().sessions
): SessionRestoreSnapshot | null {
  const layout = useLayout.getState()
  const groups: SessionRestoreGroup[] = []
  let activeGroupIndex = 0

  for (const g of layout.groups) {
    const capturable = restorableSessions(sessions, g.id)
    if (!capturable.length) continue

    const sidToItem = new Map<string, string>()
    const items: SessionRestoreItem[] = capturable.map((s) => {
      const id = newItemId()
      sidToItem.set(s.id, id)
      return {
        id,
        kind: s.kind === 'remote' ? 'remote' : 'local',
        connectionId: s.kind === 'remote' ? s.connectionId : undefined,
        cwd: s.cwd,
        title: s.customTitle ? s.title : undefined
      }
    })

    const root = g.root
    const layoutSnap = snapshotNode(root, sidToItem)
    if (g.id === layout.activeGroupId) activeGroupIndex = groups.length
    groups.push({
      name: g.name || 'Terminals',
      items,
      layout: layoutSnap
    })
  }

  if (!groups.length) return null
  return {
    version: 1,
    savedAt: Date.now(),
    groups,
    activeGroupIndex
  }
}

/** Persist the current layout if anything restorable is open. */
export async function persistSessionRestore(): Promise<void> {
  try {
    const snap = captureSessionRestoreSnapshot()
    if (!snap) {
      await window.devterm.sessionRestore.clear()
      return
    }
    await window.devterm.sessionRestore.save(snap)
  } catch {
    /* ignore — restore is best-effort */
  }
}

/**
 * Reopen a snapshot into fresh groups. Returns true when at least one
 * terminal was created. Uses the same launch path as workspaces.
 */
export async function restoreSessionSnapshot(
  snap: SessionRestoreSnapshot,
  conns: SavedConnection[]
): Promise<boolean> {
  if (!snap?.groups?.length) return false

  let opened = 0
  let activeGroupId: string | null = null
  const preferred = snap.activeGroupIndex ?? 0

  for (let i = 0; i < snap.groups.length; i++) {
    const g = snap.groups[i]
    const items = (g.items ?? []).filter(
      (it) =>
        it.kind === 'local' || (it.kind === 'remote' && typeof it.connectionId === 'string')
    )
    if (!items.length) continue

    const ws: Workspace = {
      id: `session-restore-${i}-${Date.now()}`,
      name: g.name || (i === 0 ? 'Terminals' : `Group ${i + 1}`),
      items: items.map((it) => ({
        id: it.id,
        kind: it.kind,
        connectionId: it.connectionId,
        cwd: it.cwd,
        title: it.title
      })),
      layout: g.layout ?? null
    }

    // First group: put sessions into the default group when it's still empty,
    // so we don't leave a blank "Terminals" tab behind.
    if (i === 0) {
      const layout = useLayout.getState()
      const def = layout.groups.find((x) => x.id === DEFAULT_GROUP)
      const defEmpty = !def?.root || (def.root.type === 'leaf' && def.root.tabs.length === 0)
      if (defEmpty && useSessions.getState().sessions.length === 0) {
        const sessionMap = await openItemsIntoGroup(ws, conns, DEFAULT_GROUP)
        opened += sessionMap.size
        if (sessionMap.size > 0) {
          const live = ws.layout ? toLiveSnapshot(ws.layout, sessionMap) : null
          await new Promise<void>((r) => setTimeout(r, 80))
          if (live) useLayout.getState().restoreGroup(DEFAULT_GROUP, ws.name, live)
          activeGroupId = DEFAULT_GROUP
        }
        if (i === preferred && activeGroupId) {
          /* already default */
        }
        continue
      }
    }

    const { groupId, sessionMap } = await launchWorkspaceIntoGroup(ws, conns, {
      recordLaunch: false
    })
    opened += sessionMap.size
    if (i === preferred) activeGroupId = groupId
  }

  if (activeGroupId) useLayout.getState().setActiveGroup(activeGroupId)
  return opened > 0
}

/** Open workspace items into an existing group id (default group on first restore). */
async function openItemsIntoGroup(
  ws: Workspace,
  conns: SavedConnection[],
  groupId: string
): Promise<Map<string, string>> {
  const { addLocal, connectSsh } = useSessions.getState()
  useLayout.getState().ensureGroup(groupId, ws.name)
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
  return sessionMap
}
