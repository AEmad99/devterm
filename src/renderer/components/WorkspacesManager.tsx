import { useEffect, useState } from 'react'
import type { SavedConnection, Workspace, WorkspaceItem } from '@shared/types'
import { useSessions } from '../store/sessions'
import { useLayout } from '../store/layout'
import { toLiveSnapshot } from '../lib/workspace'
import { IconGroup, IconConnect, IconTrash } from './Icons'

/**
 * Full-pane list of saved terminal workspaces — its own top-level tab.
 *
 * This tab is now read-only: it shows each saved workspace's name and a brief
 * description, and lets you launch or delete it. Workspaces are *created* from
 * the Terminals view (the group bar's "Save as workspace" button), not here.
 * Launch reopens every terminal, restores each working directory (best-effort),
 * and rebuilds the same split arrangement in its own new group.
 */
export default function WorkspacesManager({ onLaunch }: { onLaunch: () => void }) {
  const connectSsh = useSessions((s) => s.connectSsh)
  const addLocal = useSessions((s) => s.addLocal)

  const [list, setList] = useState<Workspace[]>([])
  const [conns, setConns] = useState<SavedConnection[]>([])

  useEffect(() => {
    window.devterm.workspaces.list().then(setList)
    window.devterm.connections.list().then(setConns)
  }, [])

  const connName = (id?: string) =>
    (id && conns.find((c) => c.id === id)?.name) || '(deleted connection)'

  const itemLabel = (it: WorkspaceItem) =>
    it.kind === 'local' ? (it.title ?? 'Local') : connName(it.connectionId)

  const del = async (id: string) => setList(await window.devterm.workspaces.delete(id))

  const launch = async (ws: Workspace) => {
    onLaunch()
    // Each launch opens into its own group tab (named after the workspace), so it
    // sits beside — never on top of — whatever terminals are already open.
    const groupId = `ws-${ws.id}-${Date.now()}`
    useLayout.getState().ensureGroup(groupId, ws.name)

    const map = new Map<string, string>() // workspace-item id -> new live session id
    // Open each terminal. Locals are synchronous; remotes connect in parallel.
    await Promise.all(
      ws.items.map(async (it) => {
        if (it.kind === 'local') {
          map.set(it.id, addLocal({ cwd: it.cwd, groupId }))
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
        if (sid) map.set(it.id, sid)
      })
    )
    const snap = ws.layout ? toLiveSnapshot(ws.layout, map) : null
    // Let App's layout-sync effect stack the new sessions into the group first,
    // then either overwrite with the saved split arrangement, or — if there's no
    // saved layout — just focus the group (the stacked layout already stands;
    // calling restoreGroup with null would wipe those freshly-added tabs).
    setTimeout(() => {
      const layout = useLayout.getState()
      if (snap) layout.restoreGroup(groupId, ws.name, snap)
      else layout.setActiveGroup(groupId)
    }, 80)
  }

  const counts = (ws: Workspace) => {
    const local = ws.items.filter((i) => i.kind === 'local').length
    const remote = ws.items.length - local
    const parts: string[] = []
    if (remote) parts.push(`${remote} remote`)
    if (local) parts.push(`${local} local`)
    return parts.join(' · ')
  }

  return (
    <div className="manager">
      <div className="manager-head">
        <h2>Workspaces</h2>
      </div>
      <p className="manager-sub">
        Saved sets of terminals — local and remote, their working directories, and the split layout.
        Launch one to reopen the whole set in its own group. Create a workspace from the Terminals
        view with “Save as workspace”.
      </p>

      {list.length === 0 ? (
        <div className="manager-empty">
          No workspaces yet. Arrange some terminals in the Terminals view, then use “Save as
          workspace”.
        </div>
      ) : (
        <div className="manager-list">
          {list.map((ws) => (
            <div key={ws.id} className="manager-row">
              <div className="mr-icon">
                <IconGroup size={20} />
              </div>
              <div className="mr-main">
                <div className="mr-name">{ws.name}</div>
                <div className="mr-sub">
                  {ws.items.length} terminal{ws.items.length === 1 ? '' : 's'}
                  {counts(ws) ? ` · ${counts(ws)}` : ''} · {ws.items.map(itemLabel).join(', ')}
                </div>
              </div>
              <div className="mr-actions">
                <button className="btn primary" onClick={() => launch(ws)}>
                  <IconConnect size={14} />
                  Launch
                </button>
                <button className="btn danger" onClick={() => del(ws.id)}>
                  <IconTrash size={14} />
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
