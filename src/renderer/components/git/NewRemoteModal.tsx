import { useState } from 'react'
import type { GitScope } from './GitPanel'
import ModalShell from '../common/ModalShell'

/** Add a remote: name + URL. Defaults the name to "origin" and suggests
 *  SSH/HTTPS URL conventions based on a hostname the user starts typing. */
export default function NewRemoteModal({
  scope,
  onClose,
  onDone
}: {
  scope: GitScope
  onClose: () => void
  onDone: () => void
}) {
  const [name, setName] = useState('origin')
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const submit = async () => {
    const n = name.trim()
    const u = url.trim()
    if (!n) {
      setErr('Remote name is required')
      return
    }
    if (!u) {
      setErr('URL is required')
      return
    }
    setBusy(true)
    setErr(null)
    const r = await window.devterm.git.addRemote({ ...scope, name: n, url: u })
    setBusy(false)
    if (!r.ok) {
      setErr(r.stderr.trim() || r.stdout.trim() || `exit ${r.code ?? '?'}`)
      return
    }
    onDone()
    onClose()
  }

  return (
    <ModalShell
      open
      onClose={onClose}
      title="Add remote"
      size="md"
      footer={
        <>
          <span className="spacer" />
          <button className="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="primary" onClick={submit} disabled={busy}>
            Add
          </button>
        </>
      }
    >
      <label className="git-field">
        <span>Remote name</span>
        <input
          autoFocus
          className="git-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="origin"
          spellCheck={false}
        />
      </label>
      <label className="git-field">
        <span>URL</span>
        <input
          className="git-input"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="git@github.com:owner/repo.git or https://github.com/owner/repo.git"
          spellCheck={false}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit()
          }}
        />
      </label>
      {err && <div className="git-modal-error">{err}</div>}
    </ModalShell>
  )
}
