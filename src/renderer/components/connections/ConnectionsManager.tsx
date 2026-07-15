import { useEffect, useState } from 'react'
import type { SavedConnection } from '@shared/types'
import { useSessions } from '../../store/sessions'
import ConnectionForm from './ConnectionForm'
import KnownHostsModal from './KnownHostsModal'
import ManagerList from '../common/ManagerList'
import ManagerRow from '../common/ManagerRow'
import Button from '../common/Button'
import { IconRemote, IconPlus, IconConnect, IconEdit, IconTrash } from '../common/Icons'

/**
 * Full-pane manager for saved SSH connections — its own top-level tab. Lists
 * saved connections with connect / edit / delete, and opens the ConnectionForm
 * modal for adding or editing. Connecting hands off to the session store and
 * asks the app to switch back to the Terminals view.
 */
export default function ConnectionsManager({ onConnect }: { onConnect: () => void }) {
  const connectSsh = useSessions((s) => s.connectSsh)
  const [saved, setSaved] = useState<SavedConnection[]>([])
  // null = form closed; { initial } = open (initial undefined → new connection).
  const [form, setForm] = useState<{ initial?: SavedConnection } | null>(null)
  const [knownHostsOpen, setKnownHostsOpen] = useState(false)

  const refresh = () => window.devterm.connections.list().then(setSaved)
  useEffect(() => {
    refresh()
    return window.devterm.settingsIo.onImported(refresh)
  }, [])

  const connect = (c: SavedConnection) => {
    const { id: _id, name: _name, ...profile } = c
    connectSsh(profile, { connectionId: c.id })
    onConnect()
  }

  const del = async (id: string) => setSaved(await window.devterm.connections.delete(id))

  return (
    <div className="manager">
      <div className="manager-head">
        <h2>Saved connections</h2>
        <span className="spacer" />
        <Button onClick={() => setKnownHostsOpen(true)}>Known hosts…</Button>
        <Button variant="primary" onClick={() => setForm({})}>
          <IconPlus size={15} />
          New connection
        </Button>
      </div>

      {saved.length === 0 ? (
        <div className="manager-empty">
          No saved connections yet. Click “＋ New connection” to add one.
        </div>
      ) : (
        <ManagerList>
          {saved.map((c) => (
            <ManagerRow
              key={c.id}
              icon={<IconRemote size={20} />}
              title={c.name}
              subtitle={
                <>
                  {c.username}@{c.host}
                  {c.port && c.port !== 22 ? `:${c.port}` : ''}
                  {c.jump ? `  ⤷ via ${c.jump.username}@${c.jump.host}` : ''}
                </>
              }
              actions={
                <>
                  <Button variant="primary" onClick={() => connect(c)}>
                    <IconConnect size={14} />
                    Connect
                  </Button>
                  <Button onClick={() => setForm({ initial: c })}>
                    <IconEdit size={14} />
                    Edit
                  </Button>
                  <Button variant="danger" onClick={() => del(c.id)}>
                    <IconTrash size={14} />
                    Delete
                  </Button>
                </>
              }
            />
          ))}
        </ManagerList>
      )}

      {form && (
        <ConnectionForm
          initial={form.initial}
          onSaved={(list) => setSaved(list)}
          onClose={() => {
            setForm(null)
            refresh()
          }}
        />
      )}
      {knownHostsOpen && <KnownHostsModal onClose={() => setKnownHostsOpen(false)} />}
    </div>
  )
}
