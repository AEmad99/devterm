import { useState } from 'react'
import type { GitScope } from './GitPanel'
import ModalShell from '../common/ModalShell'

/** Create a new tag at HEAD (or a specified ref). Annotated when a message is provided. */
export default function NewTagModal({
  scope,
  onClose,
  onDone
}: {
  scope: GitScope
  onClose: () => void
  onDone: () => void
}) {
  const [name, setName] = useState('')
  const [ref, setRef] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const submit = async () => {
    const n = name.trim()
    if (!n) {
      setErr('Tag name is required')
      return
    }
    setBusy(true)
    setErr(null)
    const r = await window.devterm.git.tagCreate({
      ...scope,
      name: n,
      ref: ref.trim() || undefined,
      message: message.trim() || undefined
    })
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
      title="New tag"
      size="md"
      footer={
        <>
          <span className="spacer" />
          <button className="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="primary" onClick={submit} disabled={busy}>
            Create
          </button>
        </>
      }
    >
      <label className="git-field">
        <span>Tag name</span>
        <input
          autoFocus
          className="git-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="v1.0.0"
          spellCheck={false}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit()
          }}
        />
      </label>
      <label className="git-field">
        <span>At ref (optional)</span>
        <input
          className="git-input"
          value={ref}
          onChange={(e) => setRef(e.target.value)}
          placeholder="HEAD or abc1234"
          spellCheck={false}
        />
      </label>
      <label className="git-field">
        <span>Message (leave blank for a lightweight tag)</span>
        <textarea
          className="git-textarea"
          rows={4}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Release notes…"
          spellCheck
        />
      </label>
      {err && <div className="git-modal-error">{err}</div>}
    </ModalShell>
  )
}
