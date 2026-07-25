import { useState } from 'react'
import type { GitScope } from './GitPanel'
import ModalShell from '../common/ModalShell'

/**
 * The Commit modal — a textarea for the commit message and a footer with
 * Commit / Amend / Cancel buttons. Pressing Ctrl/Cmd+Enter commits. The
 * caller is expected to have files staged; if nothing is staged the commit
 * button is disabled.
 */
export default function CommitModal({
  scope,
  onClose,
  onDone
}: {
  scope: GitScope
  onClose: () => void
  onDone: () => void
}) {
  const [message, setMessage] = useState('')
  const [amend, setAmend] = useState(false)
  const [signOff, setSignOff] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const submit = async () => {
    if (!amend && !message.trim()) {
      setErr('Commit message is required')
      return
    }
    setBusy(true)
    setErr(null)
    const r = await window.devterm.git.commit({
      ...scope,
      message: message.trim(),
      amend,
      signOff
    })
    setBusy(false)
    if (!r.ok) {
      setErr(r.stderr.trim() || r.stdout.trim() || `exit ${r.code ?? '?'}`)
      return
    }
    setMessage('')
    onDone()
    onClose()
  }

  return (
    <ModalShell
      open
      onClose={onClose}
      title="Commit"
      size="md"
      footer={
        <>
          <label className="git-check">
            <input type="checkbox" checked={amend} onChange={(e) => setAmend(e.target.checked)} />
            Amend
          </label>
          <label className="git-check">
            <input
              type="checkbox"
              checked={signOff}
              onChange={(e) => setSignOff(e.target.checked)}
            />
            Sign-off
          </label>
          <span className="spacer" />
          <button className="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="primary" onClick={submit} disabled={busy}>
            Commit
          </button>
        </>
      }
    >
      <textarea
        className="git-textarea"
        autoFocus
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        placeholder={
          amend ? 'New commit message (leave blank to keep existing message)' : 'Commit message'
        }
        spellCheck
        rows={amend ? 4 : 8}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault()
            void submit()
          }
        }}
      />
      {err && <div className="git-modal-error">{err}</div>}
      <div className="git-hint">Tip: Ctrl/Cmd+Enter to commit</div>
    </ModalShell>
  )
}
