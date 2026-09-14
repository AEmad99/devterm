import type {
  SavedConnection,
  SessionRestoreEditor,
  SessionRestoreGroup,
  SessionRestoreItem,
  SessionRestoreSnapshot,
  WorkspaceLayoutNode
} from '@shared/types'
import { useLayout, DEFAULT_GROUP, type LayoutNode } from '../store/layout'
import { useSessions, type Session } from '../store/sessions'
import { useEditors } from '../store/editors'
import { toLiveSnapshot } from './workspace'
import { setAgentUiMode } from './agent-ui'

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

/**
 * Sessions we can recreate after a restart: local shells, saved SSH
 * connections, and browser panes (their last URL). Ad-hoc SSH is still
 * skipped — there is no saved profile to reconnect with.
 */
export function restorableSessions(sessions: Session[], groupId: string): Session[] {
  return sessions.filter(
    (s) =>
      (s.groupId || DEFAULT_GROUP) === groupId &&
      !s.closed &&
      !s.id.startsWith('pending-') &&
      (s.kind === 'local' ||
        s.kind === 'browser' ||
        (s.kind === 'remote' && !!s.connectionId))
  )
}

/** Build a snapshot of every non-empty group for persistence. */
export function captureSessionRestoreSnapshot(
  sessions: Session[] = useSessions.getState().sessions
): SessionRestoreSnapshot | null {
  const layout = useLayout.getState()
  const groups: SessionRestoreGroup[] = []
  let activeGroupIndex = 0
  // session id → restore item id, across all groups (editors may reference any).
  const sidToItem = new Map<string, string>()

  for (const g of layout.groups) {
    const capturable = restorableSessions(sessions, g.id)
    if (!capturable.length) continue

    const items: SessionRestoreItem[] = capturable.map((s) => {
      const id = newItemId()
      sidToItem.set(s.id, id)
      return {
        id,
        kind: s.kind === 'remote' ? 'remote' : s.kind === 'browser' ? 'browser' : 'local',
        connectionId: s.kind === 'remote' ? s.connectionId : undefined,
        cwd: s.cwd,
        title: s.customTitle ? s.title : undefined,
        url: s.kind === 'browser' ? s.url : undefined,
        // Relaunch the agent when it was alive at snapshot time.
        agentKind: s.agentUiMode ? s.agentKind : undefined,
        agentUiMode: s.agentUiMode
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

  // Open editor documents, referencing their owning remote item when possible.
  const editors: SessionRestoreEditor[] = useEditors
    .getState()
    .docs.filter((d) => d.state === 'ready' || d.state === 'loading')
    .map((d) => ({
      scope: d.scope,
      itemId: d.scope === 'remote' && d.sessionId ? sidToItem.get(d.sessionId) : undefined,
      path: d.path
    }))
    .filter((d) => d.scope === 'local' || !!d.itemId)
    .slice(0, 64)

  return {
    version: 1,
    savedAt: Date.now(),
    groups,
    activeGroupIndex,
    editors: editors.length ? editors : undefined
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

/** Open one snapshot group's items into an existing/new group id. */
async function openItemsIntoGroup(
  items: SessionRestoreItem[],
  conns: SavedConnection[],
  groupId: string
): Promise<Map<string, string>> {
  const { addLocal, addBrowser, connectSsh } = useSessions.getState()
  const sessionMap = new Map<string, string>()
  await Promise.all(
    items.map(async (it) => {
      if (it.kind === 'local') {
        sessionMap.set(it.id, addLocal({ cwd: it.cwd, groupId, title: it.title }))
        return
      }
      if (it.kind === 'browser') {
        sessionMap.set(it.id, addBrowser({ url: it.url, groupId }))
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

/** Relaunch agents and reopen editors captured in the snapshot (best-effort). */
async function restoreAgentsAndEditors(
  groups: SessionRestoreGroup[],
  groupSessionMaps: Map<string, string>[],
  snap: SessionRestoreSnapshot
): Promise<void> {
  // item id → live session id
  const itemToSession = new Map<string, string>()
  groups.forEach((g, i) => {
    for (const [itemId, sid] of groupSessionMaps[i] ?? []) itemToSession.set(itemId, sid)
  })

  for (let i = 0; i < groups.length; i++) {
    for (const it of groups[i].items) {
      if (!it.agentUiMode || !it.agentKind) continue
      const sid = itemToSession.get(it.id)
      if (!sid) continue
      try {
        await setAgentUiMode(sid, it.agentUiMode, { kind: it.agentKind })
      } catch {
        /* agent relaunch is best-effort */
      }
    }
  }

  for (const ed of snap.editors ?? []) {
    try {
      if (ed.scope === 'local') {
        useEditors.getState().open({ scope: 'local', path: ed.path })
      } else if (ed.itemId) {
        const sid = itemToSession.get(ed.itemId)
        if (sid) useEditors.getState().open({ scope: 'remote', sessionId: sid, path: ed.path })
      }
    } catch {
      /* editor restore is best-effort */
    }
  }
}

/**
 * Reopen a snapshot into fresh groups. Returns the number of terminals
 * recreated (0 when nothing could be restored). Uses the same launch path as
 * workspaces.
 */
export async function restoreSessionSnapshot(
  snap: SessionRestoreSnapshot,
  conns: SavedConnection[]
): Promise<number> {
  if (!snap?.groups?.length) return 0

  let opened = 0
  let activeGroupId: string | null = null
  const preferred = snap.activeGroupIndex ?? 0
  const groupSessionMaps: Map<string, string>[] = []

  for (let i = 0; i < snap.groups.length; i++) {
    const g = snap.groups[i]
    const items = (g.items ?? []).filter(
      (it) =>
        it.kind === 'local' ||
        it.kind === 'browser' ||
        (it.kind === 'remote' && typeof it.connectionId === 'string')
    )
    if (!items.length) continue

    const layout = useLayout.getState()
    const def = layout.groups.find((x) => x.id === DEFAULT_GROUP)
    const defEmpty =
      (!def?.root || (def.root.type === 'leaf' && def.root.tabs.length === 0)) &&
      useSessions.getState().sessions.length === 0

    const groupId =
      i === 0 && defEmpty ? DEFAULT_GROUP : `sr-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 6)}`
    const name = g.name || (i === 0 ? 'Terminals' : `Group ${i + 1}`)
    useLayout.getState().ensureGroup(groupId, name)

    const sessionMap = await openItemsIntoGroup(items, conns, groupId)
    opened += sessionMap.size
    groupSessionMaps[i] = sessionMap
    if (i === preferred && sessionMap.size > 0) activeGroupId = groupId
    if (activeGroupId === null && sessionMap.size > 0) activeGroupId = groupId

    // Defer the layout restore so App's layout-sync effect can stack the new
    // sessions into the group first.
    if (sessionMap.size > 0) {
      const live = g.layout ? toLiveSnapshot(g.layout, sessionMap) : null
      await new Promise<void>((r) => setTimeout(r, 80))
      if (live) useLayout.getState().restoreGroup(groupId, name, live)
    }
  }

  await restoreAgentsAndEditors(snap.groups, groupSessionMaps, snap)
  if (activeGroupId) useLayout.getState().setActiveGroup(activeGroupId)
  return opened
}
