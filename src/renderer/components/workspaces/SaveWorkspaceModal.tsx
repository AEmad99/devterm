import { useEffect, useState } from 'react'
import type { SavedConnection } from '@shared/types'
import type { Session } from '../../store/sessions'
import { IconLocal, IconRemote } from '../common/Icons'

/**
 * Names and saves the active group's terminals as a workspace. Opened from the
 * Terminals view (the group bar's "Save as workspace" button) — the Workspaces
 * tab is now just a read-only list of saved workspaces. The capturable sessions
 * are computed by the caller and shown here as chips for confirmation.
 */
export default function SaveWorkspaceModal({
  capturable,
  onSave,
  onClose
}: {
  capturable: Session[]
  onSave: (name: string) => void | Promise<void>
  onClose: () => void
}) {
  const [name, setName] = useState('')
  const [conns, setConns] = useState<SavedConnection[]>([])

  useEffect(() => {
    window.devterm.connections.list().then(setConns)
  }, [])

  const connName = (id?: string) =>
    (id && conns.find((c) => c.id === id)?.name) || '(deleted connection)'

  const canSave = capturable.length > 0 && name.trim().length > 0
  const save = () => {
    if (canSave) onSave(name.trim())
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Save as workspace</h3>
        <p className="ws-hint">
          {capturable.length > 0
            ? `${capturable.length} terminal${capturable.length === 1 ? '' : 's'} in this group — local and remote, their working directories, and the split layout — will be captured.`
            : 'No capturable terminals in this group.'}
        </p>
        <div className="ws-form">
          <input
            className="ws-name"
            autoFocus
            value={name}
            placeholder="Workspace name (e.g. Prod cluster)"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save()
              if (e.key === 'Escape') onClose()
            }}
          />
        </div>
        {capturable.length > 0 && (
          <div className="ws-chips">
            {capturable.map((s) => (
              <span key={s.id} className="ws-chip">
                {s.kind === 'local' ? <IconLocal size={12} /> : <IconRemote size={12} />}
                {s.kind === 'local' ? s.title : connName(s.connectionId)}
              </span>
            ))}
          </div>
        )}
        <div className="actions">
          <span className="spacer" />
          <button className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={!canSave} onClick={save}>
            Save workspace
          </button>
        </div>
      </div>
    </div>
  )
}
