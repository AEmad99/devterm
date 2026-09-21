import { useEffect, useMemo, useState } from 'react'
import type { SavedConnection, SSHHop, SSHProfile } from '@shared/types'
import { encodeJump, listJumpHops, MAX_JUMP_HOPS } from '@shared/ssh-jump'
import { useSessions } from '../../store/sessions'
import { useSettings } from '../../store/settings'
import Button from '../common/Button'
import ModalFooter from '../common/ModalFooter'
import ConfirmDialog from '../common/ConfirmDialog'
import { useDirtyGuard } from '../../lib/use-dirty-guard'

type FormState = {
  name: string
  host: string
  port: string
  username: string
  password: string
  privateKeyPath: string
  passphrase: string
  useAgent: boolean
  useJump: boolean
  tags: string
  jumps: Array<{
    host: string
    port: string
    username: string
    password: string
    privateKeyPath: string
    useAgent: boolean
  }>
}

const EMPTY: FormState = {
  name: '',
  host: '',
  port: '22',
  username: '',
  password: '',
  privateKeyPath: '',
  passphrase: '',
  useAgent: true,
  useJump: false,
  tags: '',
  jumps: [{ host: '', port: '22', username: '', password: '', privateKeyPath: '', useAgent: true }]
}

function emptyJump() {
  return { host: '', port: '22', username: '', password: '', privateKeyPath: '', useAgent: true }
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
    useAgent: c.useAgent ?? (!c.password && !c.privateKeyPath),
    useJump: listJumpHops(c.jump).length > 0,
    tags: (c.tags ?? []).join(', '),
    jumps: (listJumpHops(c.jump).length ? listJumpHops(c.jump) : [{} as SSHHop]).map((h) => ({
      host: h.host ?? '',
      port: String(h.port ?? 22),
      username: h.username ?? '',
      password: h.password ?? '',
      privateKeyPath: h.privateKeyPath ?? '',
      useAgent: h.useAgent ?? (!h.password && !h.privateKeyPath)
    }))
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
    useAgent: f.useAgent,
    tags: f.tags
      .split(/[, ]+/)
      .map((t) => t.trim())
      .filter(Boolean),
    jump: f.useJump
      ? encodeJump(
          f.jumps
            .filter((j) => j.host.trim())
            .slice(0, MAX_JUMP_HOPS)
            .map((j) => ({
              host: j.host.trim(),
              port: Number(j.port) || 22,
              username: j.username.trim(),
              password: j.password || undefined,
              privateKeyPath: j.privateKeyPath.trim() || undefined,
              useAgent: j.useAgent
            }))
        )
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

  // Dirty-guard: don't silently drop a half-filled form on backdrop click.
  const base = useMemo(() => (initial ? fromSaved(initial) : EMPTY), [initial])
  const dirty = useMemo(() => JSON.stringify(f) !== JSON.stringify(base), [f, base])
  const guard = useDirtyGuard(dirty)
  const tryClose = guard.requestClose(onClose)

  useEffect(() => {
    window.devterm.connections.list().then(setSaved)
    window.devterm.quickConnect
      .list()
      .then(setRecent)
      .catch(() => undefined)
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
    void connectSsh(profile, { connectionId: c.id })
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
      useSettings.getState().markFirstRun('importedSsh')
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
    await connectSsh(profile, { connectionId })
    onClose()
  }

  const modalSize = f.useJump ? 'modal--lg' : undefined

  return (
    <div className="modal-backdrop" onClick={tryClose}>
      <form
        className={`modal conn-modal ${modalSize ?? ''}`}
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
      >
        <h3>{editingId ? 'Edit connection' : 'New connection'}</h3>
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
                    <Button
                      size="xs"
                      variant="primary"
                      title="Connect now"
                      onClick={(e) => {
                        e.stopPropagation()
                        connectSavedNow(c)
                      }}
                    >
                      Connect
                    </Button>
                    <Button
                      size="xs"
                      variant="icon"
                      title="Delete saved connection"
                      aria-label="Delete saved connection"
                      onClick={(e) => deleteSaved(c.id, e)}
                    >
                      ×
                    </Button>
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
            placeholder="(leave blank to use key or system agent)"
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
        <label
          className="checkbox"
          title="OpenSSH agent on this machine (Windows named pipe). Default on when no password or key is set."
        >
          <input type="checkbox" checked={f.useAgent} onChange={set('useAgent')} /> Use system SSH
          agent
        </label>

        <label>
          Tags
          <input
            value={f.tags}
            onChange={set('tags')}
            placeholder="prod, homelab (comma-separated)"
          />
        </label>

        <label className="checkbox">
          <input type="checkbox" checked={f.useJump} onChange={set('useJump')} /> Connect through a
          bastion (ProxyJump, up to 2 hops)
        </label>
        {f.useJump &&
          f.jumps.map((j, i) => (
            <div className="jump" key={i}>
              <div className="row">
                <label>
                  Jump host {i + 1}
                  <input
                    value={j.host}
                    onChange={(e) =>
                      setF((p) => ({
                        ...p,
                        jumps: p.jumps.map((x, n) => (n === i ? { ...x, host: e.target.value } : x))
                      }))
                    }
                  />
                </label>
                <label className="port">
                  Port
                  <input
                    value={j.port}
                    onChange={(e) =>
                      setF((p) => ({
                        ...p,
                        jumps: p.jumps.map((x, n) => (n === i ? { ...x, port: e.target.value } : x))
                      }))
                    }
                  />
                </label>
              </div>
              <label>
                Jump user
                <input
                  value={j.username}
                  onChange={(e) =>
                    setF((p) => ({
                      ...p,
                      jumps: p.jumps.map((x, n) =>
                        n === i ? { ...x, username: e.target.value } : x
                      )
                    }))
                  }
                />
              </label>
              <label>
                Jump password
                <input
                  type="password"
                  value={j.password}
                  onChange={(e) =>
                    setF((p) => ({
                      ...p,
                      jumps: p.jumps.map((x, n) =>
                        n === i ? { ...x, password: e.target.value } : x
                      )
                    }))
                  }
                />
              </label>
              <label>
                Jump key path
                <input
                  value={j.privateKeyPath}
                  onChange={(e) =>
                    setF((p) => ({
                      ...p,
                      jumps: p.jumps.map((x, n) =>
                        n === i ? { ...x, privateKeyPath: e.target.value } : x
                      )
                    }))
                  }
                />
              </label>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={j.useAgent}
                  onChange={(e) =>
                    setF((p) => ({
                      ...p,
                      jumps: p.jumps.map((x, n) =>
                        n === i ? { ...x, useAgent: e.target.checked } : x
                      )
                    }))
                  }
                />{' '}
                Use system SSH agent for jump host
              </label>
              {f.jumps.length > 1 && (
                <Button
                  variant="ghost"
                  type="button"
                  onClick={() =>
                    setF((p) => ({ ...p, jumps: p.jumps.filter((_, n) => n !== i) }))
                  }
                >
                  Remove hop
                </Button>
              )}
            </div>
          ))}
        {f.useJump && f.jumps.length < MAX_JUMP_HOPS && (
          <Button
            variant="ghost"
            type="button"
            onClick={() => setF((p) => ({ ...p, jumps: [...p.jumps, emptyJump()] }))}
          >
            Add jump host
          </Button>
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
          <ModalFooter
            start={
              editingId ? (
                <Button
                  variant="ghost"
                  onClick={() => {
                    setF(EMPTY)
                    setEditingId(null)
                    setDoSave(false)
                  }}
                >
                  New
                </Button>
              ) : undefined
            }
          >
            <Button variant="ghost" onClick={tryClose}>
              Cancel
            </Button>
            <Button variant="primary" type="submit">
              {editingId ? 'Save & Connect' : 'Connect'}
            </Button>
          </ModalFooter>
        </div>
      </form>
      {guard.confirming && (
        <ConfirmDialog
          open
          title="Discard changes?"
          message="Close without connecting? Your edits will be lost."
          confirmLabel="Discard"
          onConfirm={guard.confirm}
          onClose={guard.cancel}
        />
      )}
    </div>
  )
}
