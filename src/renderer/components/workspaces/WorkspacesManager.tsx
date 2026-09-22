import { useEffect, useMemo, useState } from 'react'
import type { SavedConnection, Workspace, WorkspaceItem } from '@shared/types'
import { launchWorkspaceIntoGroup } from '../../lib/workspace'
import { useSettings } from '../../store/settings'
import { toast } from '../../store/toasts'
import ManagerList, { ManagerSkeleton } from '../common/ManagerList'
import ManagerRow from '../common/ManagerRow'
import Button from '../common/Button'
import { IconGroup, IconConnect, IconTrash, IconEdit, IconCopy, IconPin } from '../common/Icons'

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
  const pinned = useSettings((s) => s.pinned.workspaces)
  const togglePin = useSettings((s) => s.togglePin)
  const [list, setList] = useState<Workspace[]>([])
  const [loading, setLoading] = useState(true)
  const [conns, setConns] = useState<SavedConnection[]>([])
  // Inline editor state. `null` = closed. `id` picks the row, `name` + `description`
  // are the editable fields; the original is preserved for cancel.
  const [editing, setEditing] = useState<{
    id: string
    name: string
    description: string
  } | null>(null)

  const refresh = async () => {
    setList(await window.devterm.workspaces.list())
    setLoading(false)
  }
  useEffect(() => {
    void refresh()
    window.devterm.connections.list().then(setConns)
    return window.devterm.settingsIo.onImported(() => {
      void refresh()
      window.devterm.connections.list().then(setConns)
    })
  }, [])

  const ordered = useMemo(() => {
    const pinIndex = new Map(pinned.map((id, i) => [id, i]))
    return [...list].sort((a, b) => {
      const pa = pinIndex.has(a.id) ? 0 : 1
      const pb = pinIndex.has(b.id) ? 0 : 1
      if (pa !== pb) return pa - pb
      if (pa === 0) return (pinIndex.get(a.id) ?? 0) - (pinIndex.get(b.id) ?? 0)
      return (b.lastLaunchedAt ?? 0) - (a.lastLaunchedAt ?? 0)
    })
  }, [list, pinned])

  const connName = (id?: string) =>
    (id && conns.find((c) => c.id === id)?.name) || '(deleted connection)'

  const itemLabel = (it: WorkspaceItem) =>
    it.kind === 'local' ? (it.title ?? 'Local') : connName(it.connectionId)

  const del = async (ws: Workspace) => {
    setList(await window.devterm.workspaces.delete(ws.id))
    toast(`Deleted “${ws.name}”`, 'ok')
  }

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
    toast('Workspace updated', 'ok')
  }

  const duplicate = async (ws: Workspace) => {
    setList(await window.devterm.workspaces.duplicate(ws.id))
    toast(`Duplicated “${ws.name}”`, 'ok')
  }

  const launch = async (ws: Workspace) => {
    onLaunch()
    // Each launch opens into its own group tab (named after the workspace), so
    // it sits beside — never on top of — whatever terminals are already open.
    // `recordLaunch: true` so the server-side count is bumped for the user's
    // click (auto-launch on app boot does NOT count; the count tracks
    // operator-initiated launches).
    await launchWorkspaceIntoGroup(ws, conns, { recordLaunch: true })
    // Refresh the list to pick up the new lastLaunchedAt / launchCount.
    void refresh()
  }

  const toggleAutoLaunch = async (ws: Workspace, value: boolean) => {
    const next = await window.devterm.workspaces.save({ ...ws, autoLaunch: value })
    setList(next)
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
      : d.toLocaleString(undefined, {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit'
        })
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

      {loading ? (
        <ManagerSkeleton />
      ) : list.length === 0 ? (
        <div className="manager-empty">
          No workspaces yet. Arrange some terminals in the Terminals view, then use “Save as
          workspace”.
          <div className="manager-empty-actions">
            <Button variant="primary" onClick={onLaunch}>
              <IconConnect size={14} />
              Go to Terminals
            </Button>
          </div>
        </div>
      ) : (
        <ManagerList>
          {ordered.map((ws) => {
            const isEditing = editing?.id === ws.id
            const launched = formatLaunched(ws.lastLaunchedAt)
            const isPinned = pinned.includes(ws.id)
            return (
              <ManagerRow
                key={ws.id}
                className={isPinned ? 'is-pinned' : ''}
                icon={<IconGroup size={20} />}
                onDoubleClick={isEditing ? undefined : () => launch(ws)}
                meta={
                  isEditing ? (
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
                        {counts(ws) ? ` · ${counts(ws)}` : ''} ·{' '}
                        {ws.items.map(itemLabel).join(', ')}
                      </div>
                      <div className="mr-stats">
                        {launched && <span>last launched {launched}</span>}
                        {launched && ((ws.launchCount ?? 0) > 0 || ws.autoLaunch) ? ' · ' : ''}
                        {(ws.launchCount ?? 0) > 0 && (
                          <span>
                            {ws.launchCount} launch{ws.launchCount === 1 ? '' : 'es'}
                          </span>
                        )}
                        {(ws.launchCount ?? 0) > 0 && ws.autoLaunch ? ' · ' : ''}
                        <label className="ws-auto-launch">
                          <input
                            type="checkbox"
                            checked={ws.autoLaunch === true}
                            onChange={(e) => void toggleAutoLaunch(ws, e.target.checked)}
                          />
                          <span>auto-launch on startup</span>
                        </label>
                      </div>
                    </>
                  )
                }
                actions={
                  isEditing ? (
                    <>
                      <Button variant="primary" onClick={saveEdit}>
                        Save
                      </Button>
                      <Button variant="ghost" onClick={cancelEdit}>
                        Cancel
                      </Button>
                    </>
                  ) : (
                    <Button variant="primary" onClick={() => launch(ws)}>
                      <IconConnect size={14} />
                      Launch
                    </Button>
                  )
                }
                secondaryActions={
                  isEditing ? undefined : (
                    <>
                      <Button
                        variant="icon"
                        active={isPinned}
                        onClick={() => togglePin('workspaces', ws.id)}
                        title={isPinned ? 'Unpin from top' : 'Pin to top'}
                        aria-label={isPinned ? `Unpin ${ws.name}` : `Pin ${ws.name}`}
                      >
                        <IconPin size={14} />
                      </Button>
                      <Button onClick={() => startEdit(ws)} title="Rename / edit description">
                        <IconEdit size={14} />
                        <span className="btn-label">Update</span>
                      </Button>
                      <Button onClick={() => duplicate(ws)} title="Create a copy of this workspace">
                        <IconCopy size={14} />
                        <span className="btn-label">Duplicate</span>
                      </Button>
                      <Button
                        variant="danger"
                        onClick={() => del(ws)}
                        title="Delete this workspace"
                      >
                        <IconTrash size={14} />
                        <span className="btn-label">Delete</span>
                      </Button>
                    </>
                  )
                }
              />
            )
          })}
        </ManagerList>
      )}
    </div>
  )
}
