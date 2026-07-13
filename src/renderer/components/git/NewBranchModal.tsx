import { useState } from 'react'
import type { GitScope } from './GitPanel'
import ModalShell from '../common/ModalShell'

/**
 * The NewBranch modal — name + (optional) starting ref. Toggle to switch
 * straight into the new branch after creation; default = create only (stay
 * on current branch).
 */
export default function NewBranchModal({
  scope,
  onClose,
  onDone
}: {
  scope: GitScope
  onClose: () => void
  onDone: () => void
}) {
  const [name, setName] = useState('')
  const [from, setFrom] = useState('')
  const [checkout, setCheckout] = useState(true)
  const [track, setTrack] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const submit = async () => {
    const n = name.trim()
    if (!n) {
      setErr('Branch name is required')
      return
    }
    setBusy(true)
    setErr(null)
    let r = await window.devterm.git.createBranch({
      ...scope,
      name: n,
      from: from.trim() || undefined,
      track
    })
    if (r.ok && checkout) {
      r = await window.devterm.git.checkout({ ...scope, target: n })
    }
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
      title="New branch"
      size="md"
      footer={
        <>
          <span className="spacer" />
          <button className="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="primary" onClick={submit} disabled={busy}>
            {checkout ? 'Create & switch' : 'Create'}
          </button>
        </>
      }
    >
      <label className="git-field">
        <span>Branch name</span>
        <input
          autoFocus
          className="git-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="feature/my-branch"
          spellCheck={false}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit()
          }}
        />
      </label>
      <label className="git-field">
        <span>From (ref, optional)</span>
        <input
          className="git-input"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          placeholder="HEAD or origin/main"
          spellCheck={false}
        />
      </label>
      <label className="git-check">
        <input type="checkbox" checked={checkout} onChange={(e) => setCheckout(e.target.checked)} />
        Switch to new branch
      </label>
      <label className="git-check">
        <input type="checkbox" checked={track} onChange={(e) => setTrack(e.target.checked)} />
        Track upstream (use when `From` is a remote ref)
      </label>
      {err && <div className="git-modal-error">{err}</div>}
    </ModalShell>
  )
}
