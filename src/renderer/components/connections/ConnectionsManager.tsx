import { useEffect, useMemo, useState } from 'react'
import type { SavedConnection } from '@shared/types'
import { useSessions } from '../../store/sessions'
import { useSettings } from '../../store/settings'
import { toast } from '../../store/toasts'
import ConnectionForm from './ConnectionForm'
import KnownHostsModal from './KnownHostsModal'
import ManagerList, { ManagerSkeleton } from '../common/ManagerList'
import ManagerRow from '../common/ManagerRow'
import Button from '../common/Button'
import { IconRemote, IconPlus, IconConnect, IconEdit, IconTrash, IconPin } from '../common/Icons'

/**
 * Full-pane manager for saved SSH connections — its own top-level tab. Lists
 * saved connections with connect / edit / delete, and opens the ConnectionForm
 * modal for adding or editing. Connecting hands off to the session store and
 * asks the app to switch back to the Terminals view.
 */
export default function ConnectionsManager({ onConnect }: { onConnect: () => void }) {
  const connectSsh = useSessions((s) => s.connectSsh)
  const connectRdp = useSessions((s) => s.connectRdp)
  const pinned = useSettings((s) => s.pinned.connections)
  const togglePin = useSettings((s) => s.togglePin)
  const lastConnectedAt = useSettings((s) => s.lastConnectedAt)
  const recordConnected = useSettings((s) => s.recordConnected)
  const [saved, setSaved] = useState<SavedConnection[]>([])
  const [loading, setLoading] = useState(true)
  // null = form closed; { initial } = open (initial undefined → new connection).
  const [form, setForm] = useState<{ initial?: SavedConnection } | null>(null)
  const [knownHostsOpen, setKnownHostsOpen] = useState(false)
  const [importBusy, setImportBusy] = useState(false)
  const [importHint, setImportHint] = useState<string | null>(null)

  const refresh = async () => {
    setSaved(await window.devterm.connections.list())
    setLoading(false)
  }
  useEffect(() => {
    void refresh()
    return window.devterm.settingsIo.onImported(() => void refresh())
  }, [])

  const ordered = useMemo(() => {
    const pinIndex = new Map(pinned.map((id, i) => [id, i]))
    return [...saved].sort((a, b) => {
      const pa = pinIndex.has(a.id) ? 0 : 1
      const pb = pinIndex.has(b.id) ? 0 : 1
      if (pa !== pb) return pa - pb
      if (pa === 0) return (pinIndex.get(a.id) ?? 0) - (pinIndex.get(b.id) ?? 0)
      return a.name.localeCompare(b.name)
    })
  }, [saved, pinned])

  const connect = (c: SavedConnection) => {
    const { id: _id, name: _name, ...profile } = c
    recordConnected(c.id)
    if (c.protocol === 'rdp') void connectRdp(profile, { connectionId: c.id })
    else void connectSsh(profile, { connectionId: c.id })
    onConnect()
  }

  const del = async (c: SavedConnection) => {
    setSaved(await window.devterm.connections.delete(c.id))
    toast(`Deleted “${c.name}”`, 'ok')
  }

  const importSshConfig = async () => {
    setImportBusy(true)
    setImportHint(null)
    try {
      const result = await window.devterm.connections.importSshConfig()
      setSaved(result.connections)
      const msg = result.message ?? `Imported ${result.added}`
      setImportHint(msg)
      toast(msg, result.added > 0 ? 'ok' : 'info')
    } catch (e) {
      const msg = (e as Error).message || String(e)
      setImportHint(msg)
      toast(msg, 'err')
    } finally {
      setImportBusy(false)
    }
  }

  return (
    <div className="manager">
      <div className="manager-head">
        <h2>Saved connections</h2>
        <span className="spacer" />
        <Button onClick={() => setKnownHostsOpen(true)}>Known hosts…</Button>
        <Button onClick={() => void importSshConfig()} busy={importBusy}>
          Import SSH config
        </Button>
        <Button variant="primary" onClick={() => setForm({})}>
          <IconPlus size={15} />
          New connection
        </Button>
      </div>

      {importHint && <div className="manager-hint">{importHint}</div>}

      {loading ? (
        <ManagerSkeleton />
      ) : saved.length === 0 ? (
        <div className="manager-empty">
          No saved connections yet. Create one manually or import from <code>~/.ssh/config</code>.
          <div className="manager-empty-actions">
            <Button variant="primary" onClick={() => setForm({})}>
              <IconPlus size={15} />
              New connection
            </Button>
            <Button onClick={() => void importSshConfig()} busy={importBusy}>
              Import SSH config
            </Button>
          </div>
        </div>
      ) : (
        <ManagerList>
          {ordered.map((c) => {
            const isPinned = pinned.includes(c.id)
            const last = lastConnectedAt[c.id]
            return (
              <ManagerRow
                key={c.id}
                className={isPinned ? 'is-pinned' : ''}
                icon={<IconRemote size={20} />}
                title={
                  <>
                    {c.name}
                    {last && <span className="mr-when"> · last connected {formatWhen(last)}</span>}
                  </>
                }
                subtitle={
                  <>
                    {c.username}@{c.host}
                    {c.port && c.port !== 22 ? `:${c.port}` : ''}
                    {c.jump ? `  ⤷ via ${c.jump.username}@${c.jump.host}` : ''}
                  </>
                }
                onDoubleClick={() => connect(c)}
                actions={
                  <Button variant="primary" onClick={() => connect(c)}>
                    <IconConnect size={14} />
                    Connect
                  </Button>
                }
                secondaryActions={
                  <>
                    <Button
                      variant="icon"
                      active={isPinned}
                      onClick={() => togglePin('connections', c.id)}
                      title={isPinned ? 'Unpin from top' : 'Pin to top'}
                      aria-label={isPinned ? `Unpin ${c.name}` : `Pin ${c.name}`}
                    >
                      <IconPin size={14} />
                    </Button>
                    <Button onClick={() => setForm({ initial: c })}>
                      <IconEdit size={14} />
                      Edit
                    </Button>
                    <Button variant="danger" onClick={() => del(c)}>
                      <IconTrash size={14} />
                      Delete
                    </Button>
                  </>
                }
              />
            )
          })}
        </ManagerList>
      )}

      {form && (
        <ConnectionForm
          initial={form.initial}
          onSaved={(list) => {
            setSaved(list)
            toast(form.initial ? 'Connection saved' : 'Connection created', 'ok')
          }}
          onClose={() => {
            setForm(null)
            void refresh()
          }}
        />
      )}
      {knownHostsOpen && <KnownHostsModal onClose={() => setKnownHostsOpen(false)} />}
    </div>
  )
}

function formatWhen(ts: number): string {
  const mins = Math.max(0, Math.round((Date.now() - ts) / 60000))
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(ts).toLocaleDateString()
}
