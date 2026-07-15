import { useEffect, useState } from 'react'
import type { SavedConnection, SSHProfile } from '@shared/types'
import { useSessions } from '../../store/sessions'

type FormState = {
  name: string
  host: string
  port: string
  username: string
  password: string
  privateKeyPath: string
  passphrase: string
  useJump: boolean
  jumpHost: string
  jumpPort: string
  jumpUser: string
  jumpPassword: string
  jumpKeyPath: string
}

const EMPTY: FormState = {
  name: '',
  host: '',
  port: '22',
  username: '',
  password: '',
  privateKeyPath: '',
  passphrase: '',
  useJump: false,
  jumpHost: '',
  jumpPort: '22',
  jumpUser: '',
  jumpPassword: '',
  jumpKeyPath: ''
}

/** Hydrate the form fields from a saved connection (for "edit" / "load"). */
function fromSaved(c: SavedConnection): FormState {
  return {
    name: c.name ?? '',
    host: c.host ?? '',
    port: String(c.port ?? 22),
    username: c.username ?? '',
    password: c.password ?? '',
    privateKeyPath: c.privateKeyPath ?? '',
    passphrase: c.passphrase ?? '',
    useJump: !!c.jump,
    jumpHost: c.jump?.host ?? '',
    jumpPort: String(c.jump?.port ?? 22),
    jumpUser: c.jump?.username ?? '',
    jumpPassword: c.jump?.password ?? '',
    jumpKeyPath: c.jump?.privateKeyPath ?? ''
  }
}

function toProfile(f: FormState): SSHProfile {
  return {
    host: f.host.trim(),
    port: Number(f.port) || 22,
    username: f.username.trim(),
    password: f.password || undefined,
    privateKeyPath: f.privateKeyPath.trim() || undefined,
    passphrase: f.passphrase || undefined,
    jump: f.useJump
      ? {
          host: f.jumpHost.trim(),
          port: Number(f.jumpPort) || 22,
          username: f.jumpUser.trim(),
          password: f.jumpPassword || undefined,
          privateKeyPath: f.jumpKeyPath.trim() || undefined
        }
      : undefined
  }
}

export default function ConnectionForm({
  onClose,
  initial,
  onSaved
}: {
  onClose: () => void
  /** Pre-load the form with an existing connection (edit mode). */
  initial?: SavedConnection
  /** Called with the updated list whenever a connection is saved. */
  onSaved?: (list: SavedConnection[]) => void
}) {
  const connectSsh = useSessions((s) => s.connectSsh)
  const [f, setF] = useState<FormState>(initial ? fromSaved(initial) : EMPTY)
  const [saved, setSaved] = useState<SavedConnection[]>([])
  // The id of the saved connection currently loaded (so Save overwrites it).
  const [editingId, setEditingId] = useState<string | null>(initial?.id ?? null)
  const [doSave, setDoSave] = useState(false)
  // QuickConnect: recent host:port:user for the host-input datalist.
  const [recent, setRecent] = useState<{ host: string; port: number; username: string }[]>([])

  useEffect(() => {
    window.devterm.connections.list().then(setSaved)
    window.devterm.quickConnect.list().then(setRecent).catch(() => undefined)
  }, [])

  const set = (k: keyof FormState) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setF((p) => ({ ...p, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }))

  const loadSaved = (c: SavedConnection) => {
    setF(fromSaved(c))
    setEditingId(c.id)
    setDoSave(false)
  }

  const connectSavedNow = (c: SavedConnection) => {
    const { id: _id, name: _name, ...profile } = c
    void window.devterm.quickConnect
      .record(profile.host, profile.port, profile.username)
      .catch(() => undefined)
    connectSsh(profile, { connectionId: c.id })
    onClose()
  }

  const deleteSaved = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    setSaved(await window.devterm.connections.delete(id))
    if (editingId === id) setEditingId(null)
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const profile = toProfile(f)
    let connectionId = editingId ?? undefined
    if (doSave || editingId) {
      const name = f.name.trim() || `${profile.username}@${profile.host}`
      const list = await window.devterm.connections.save({ ...profile, id: editingId ?? '', name })
      onSaved?.(list)
      // Link the live session to its saved connection (so it can join a workspace).
      connectionId =
        editingId ??
        list.find(
          (c) => c.name === name && c.host === profile.host && c.username === profile.username
        )?.id
    }
    // Record the host for QuickConnect autocomplete (no secrets).
    void window.devterm.quickConnect
      .record(profile.host, profile.port, profile.username)
      .catch(() => undefined)
    connectSsh(profile, { connectionId })
    onClose()
  }

  const modalSize = f.useJump ? 'modal--lg' : undefined

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form
        className={`modal conn-modal ${modalSize ?? ''}`}
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
      >
        <h3>{editingId ? 'Edit connection' : 'New SSH connection'}</h3>

        {saved.length > 0 && (
          <div className="saved-conns">
            <div className="saved-head">Saved connections</div>
            <div className="saved-list">
              {saved.map((c) => (
                <div
                  key={c.id}
                  className={`saved-row ${editingId === c.id ? 'active' : ''}`}
                  onClick={() => loadSaved(c)}
                  title="Click to load into the form below"
                >
                  <span className="saved-name">{c.name}</span>
                  <span className="saved-target">
                    {c.username}@{c.host}
                    {c.port && c.port !== 22 ? `:${c.port}` : ''}
                  </span>
                  <span className="saved-actions">
                    <button
                      type="button"
                      className="saved-connect"
                      title="Connect now"
                      onClick={(e) => {
                        e.stopPropagation()
                        connectSavedNow(c)
                      }}
                    >
                      Connect
                    </button>
                    <button
                      type="button"
                      className="saved-del"
                      title="Delete saved connection"
                      onClick={(e) => deleteSaved(c.id, e)}
                    >
                      ×
                    </button>
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="row">
          <label>
            Host
            <input
              value={f.host}
              onChange={set('host')}
              required
              placeholder="10.0.0.5"
              autoFocus
              list="dt-quick-connect"
            />
            {recent.length > 0 && (
              <datalist id="dt-quick-connect">
                {recent.map((r, i) => (
                  <option key={i} value={r.host}>
                    {r.username}@{r.host}:{r.port}
                  </option>
                ))}
              </datalist>
            )}
          </label>
          <label className="port">
            Port
            <input value={f.port} onChange={set('port')} />
          </label>
        </div>
        <label>
          Username
          <input value={f.username} onChange={set('username')} required placeholder="root" />
        </label>
        <label>
          Password
          <input
            type="password"
            value={f.password}
            onChange={set('password')}
            placeholder="(leave blank to use key)"
          />
        </label>
        <label>
          Private key path
          <input
            value={f.privateKeyPath}
            onChange={set('privateKeyPath')}
            placeholder="C:\Users\me\.ssh\id_ed25519"
          />
        </label>
        <label>
          Key passphrase
          <input type="password" value={f.passphrase} onChange={set('passphrase')} />
        </label>

        <label className="checkbox">
          <input type="checkbox" checked={f.useJump} onChange={set('useJump')} /> Connect through a
          bastion (ProxyJump)
        </label>
        {f.useJump && (
          <div className="jump">
            <div className="row">
              <label>
                Jump host
                <input value={f.jumpHost} onChange={set('jumpHost')} />
              </label>
              <label className="port">
                Port
                <input value={f.jumpPort} onChange={set('jumpPort')} />
              </label>
            </div>
            <label>
              Jump user
              <input value={f.jumpUser} onChange={set('jumpUser')} />
            </label>
            <label>
              Jump password
              <input type="password" value={f.jumpPassword} onChange={set('jumpPassword')} />
            </label>
            <label>
              Jump key path
              <input value={f.jumpKeyPath} onChange={set('jumpKeyPath')} />
            </label>
          </div>
        )}

        <label className="checkbox save-row">
          <input
            type="checkbox"
            checked={doSave || !!editingId}
            disabled={!!editingId}
            onChange={(e) => setDoSave(e.target.checked)}
          />
          Save this connection for next time
        </label>
        {(doSave || editingId) && (
          <label>
            Name
            <input value={f.name} onChange={set('name')} placeholder="e.g. Prod web server" />
          </label>
        )}

        <div className="actions">
          {editingId && (
            <button
              type="button"
              className="ghost"
              onClick={() => {
                setF(EMPTY)
                setEditingId(null)
                setDoSave(false)
              }}
            >
              New
            </button>
          )}
          <span className="spacer" />
          <button type="button" className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit">{editingId ? 'Save & Connect' : 'Connect'}</button>
        </div>
      </form>
    </div>
  )
}
