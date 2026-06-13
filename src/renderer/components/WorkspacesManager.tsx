import { useEffect, useState } from 'react'
import type { SavedConnection, Workspace, WorkspaceItem } from '@shared/types'
import { useSessions } from '../store/sessions'
import { useLayout } from '../store/layout'
import { toLiveSnapshot } from '../lib/workspace'
import { IconGroup, IconConnect, IconTrash, IconEdit, IconCopy } from './Icons'

/**
 * Full-pane list of saved terminal workspaces — its own top-level tab.
 *
 * Lists each saved workspace with name, description, terminal breakdown, and
 * launch stats. Lets the user:
 *   - launch the whole set in its own group (records the launch + flags the
 *     group as launched from this workspace, so the group bar can offer a
 *     "Save changes back" action),
 *   - rename in-place via the Update button,
 *   - duplicate (creates a new workspace with " (copy)" appended and a fresh id),
 *   - delete.
 * Workspaces are *created* from the Terminals view (the group bar's
 * "Save as workspace" button).
 */
export default function WorkspacesManager({ onLaunch }: { onLaunch: () => void }) {
  const connectSsh = useSessions((s) => s.connectSsh)
  const addLocal = useSessions((s) => s.addLocal)

  const [list, setList] = useState<Workspace[]>([])
  const [conns, setConns] = useState<SavedConnection[]>([])
  // Inline editor state. `null` = closed. `id` picks the row, `name` + `description`
  // are the editable fields; the original is preserved for cancel.
  const [editing, setEditing] = useState<{
    id: string
    name: string
    description: string
  } | null>(null)

  const refresh = () => window.devterm.workspaces.list().then(setList)
  useEffect(() => {
    refresh()
    window.devterm.connections.list().then(setConns)
  }, [])

  const connName = (id?: string) =>
    (id && conns.find((c) => c.id === id)?.name) || '(deleted connection)'

  const itemLabel = (it: WorkspaceItem) =>
    it.kind === 'local' ? (it.title ?? 'Local') : connName(it.connectionId)

  const del = async (id: string) => setList(await window.devterm.workspaces.delete(id))

  const startEdit = (ws: Workspace) =>
    setEditing({ id: ws.id, name: ws.name, description: ws.description ?? '' })

  const cancelEdit = () => setEditing(null)

  const saveEdit = async () => {
    if (!editing) return
    const name = editing.name.trim()
    if (name.length === 0) return
    const list2 = await window.devterm.workspaces.rename(editing.id, name)
    // Description is part of the same patch but there's no dedicated IPC for it
    // yet — fall back to the generic save (rename just updated the name; we
    // merge the description by re-saving with the latest list). This keeps the
    // patch atomic from the user's perspective.
    const target = list2.find((w) => w.id === editing.id)
    if (target) {
      setList(
        await window.devterm.workspaces.save({
          ...target,
          description: editing.description.trim() || undefined
        })
      )
    } else {
      setList(list2)
    }
    setEditing(null)
  }

  const duplicate = async (id: string) =>
    setList(await window.devterm.workspaces.duplicate(id))

  const launch = async (ws: Workspace) => {
    onLaunch()
    // Each launch opens into its own group tab (named after the workspace), so it
    // sits beside — never on top of — whatever terminals are already open.
    const groupId = `ws-${ws.id}-${Date.now()}`
    const layout = useLayout.getState()
    layout.ensureGroup(groupId, ws.name)
    // Tag the group as launched from this workspace so the group bar can offer
    // a "Save changes back to this workspace" action. Done BEFORE the terminals
    // open so the flag is set even if the user immediately closes the group.
    layout.flagGroupLaunched(groupId, ws.id)

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
      const layout2 = useLayout.getState()
      if (snap) layout2.restoreGroup(groupId, ws.name, snap)
      else layout2.setActiveGroup(groupId)
    }, 80)

    // Record the launch in the workspace stats (lastLaunchedAt + launchCount).
    // Fire-and-forget: the UI already shows the freshly-launched group, the
    // server-side count is only used to render the row on next visit.
    void window.devterm.workspaces.recordLaunch(ws.id).then(setList).catch(() => undefined)
  }

  const counts = (ws: Workspace) => {
    const local = ws.items.filter((i) => i.kind === 'local').length
    const remote = ws.items.length - local
    const parts: string[] = []
    if (remote) parts.push(`${remote} remote`)
    if (local) parts.push(`${local} local`)
    return parts.join(' · ')
  }

  const formatLaunched = (ts?: number) => {
    if (!ts) return null
    const d = new Date(ts)
    // Keep it compact: "Jun 12, 10:34" or just the date if older than 6 months.
    const sixMonths = 1000 * 60 * 60 * 24 * 180
    return Date.now() - d.getTime() > sixMonths
      ? d.toLocaleDateString()
      : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
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
          {list.map((ws) => {
            const isEditing = editing?.id === ws.id
            const launched = formatLaunched(ws.lastLaunchedAt)
            return (
              <div key={ws.id} className="manager-row">
                <div className="mr-icon">
                  <IconGroup size={20} />
                </div>
                <div className="mr-main">
                  {isEditing ? (
                    <div className="ws-edit">
                      <input
                        className="ws-edit-name"
                        autoFocus
                        value={editing!.name}
                        onChange={(e) => setEditing({ ...editing!, name: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void saveEdit()
                          if (e.key === 'Escape') cancelEdit()
                        }}
                      />
                      <input
                        className="ws-edit-desc"
                        placeholder="Description (optional)"
                        value={editing!.description}
                        onChange={(e) => setEditing({ ...editing!, description: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void saveEdit()
                          if (e.key === 'Escape') cancelEdit()
                        }}
                      />
                    </div>
                  ) : (
                    <>
                      <div className="mr-name">{ws.name}</div>
                      {ws.description && <div className="mr-desc">{ws.description}</div>}
                      <div className="mr-sub">
                        {ws.items.length} terminal{ws.items.length === 1 ? '' : 's'}
                        {counts(ws) ? ` · ${counts(ws)}` : ''} · {ws.items.map(itemLabel).join(', ')}
                      </div>
                      {(launched || (ws.launchCount ?? 0) > 0) && (
                        <div className="mr-stats">
                          {launched && <span>last launched {launched}</span>}
                          {launched && (ws.launchCount ?? 0) > 0 ? ' · ' : ''}
                          {(ws.launchCount ?? 0) > 0 && (
                            <span>
                              {ws.launchCount} launch{ws.launchCount === 1 ? '' : 'es'}
                            </span>
                          )}
                        </div>
                      )}
                    </>
                  )}
                </div>
                {isEditing ? (
                  <div className="mr-actions">
                    <button className="btn primary" onClick={saveEdit}>
                      Save
                    </button>
                    <button className="btn ghost" onClick={cancelEdit}>
                      Cancel
                    </button>
                  </div>
                ) : (
                  <div className="mr-actions">
                    <button className="btn primary" onClick={() => launch(ws)}>
                      <IconConnect size={14} />
                      Launch
                    </button>
                    <button className="btn" onClick={() => startEdit(ws)} title="Rename / edit description">
                      <IconEdit size={14} />
                      Update
                    </button>
                    <button
                      className="btn"
                      onClick={() => duplicate(ws.id)}
                      title="Create a copy of this workspace"
                    >
                      <IconCopy size={14} />
                      Duplicate
                    </button>
                    <button className="btn danger" onClick={() => del(ws.id)}>
                      <IconTrash size={14} />
                      Delete
                    </button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
