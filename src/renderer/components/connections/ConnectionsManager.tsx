import { useEffect, useState } from 'react'
import type { SavedConnection } from '@shared/types'
import { useSessions } from '../../store/sessions'
import ConnectionForm from './ConnectionForm'
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
        <button className="btn primary" onClick={() => setForm({})}>
          <IconPlus size={15} />
          New connection
        </button>
      </div>

      {saved.length === 0 ? (
        <div className="manager-empty">
          No saved connections yet. Click “＋ New connection” to add one.
        </div>
      ) : (
        <div className="manager-list">
          {saved.map((c) => (
            <div key={c.id} className="manager-row">
              <div className="mr-icon">
                <IconRemote size={20} />
              </div>
              <div className="mr-main">
                <div className="mr-name">{c.name}</div>
                <div className="mr-sub">
                  {c.username}@{c.host}
                  {c.port && c.port !== 22 ? `:${c.port}` : ''}
                  {c.jump ? `  ⤷ via ${c.jump.username}@${c.jump.host}` : ''}
                </div>
              </div>
              <div className="mr-actions">
                <button className="btn primary" onClick={() => connect(c)}>
                  <IconConnect size={14} />
                  Connect
                </button>
                <button className="btn" onClick={() => setForm({ initial: c })}>
                  <IconEdit size={14} />
                  Edit
                </button>
                <button className="btn danger" onClick={() => del(c.id)}>
                  <IconTrash size={14} />
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
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
    </div>
  )
}
