import { useEffect, useState } from 'react'
import Button from '../common/Button'
import ModalShell from '../common/ModalShell'

export type FileMutationKind = 'mkdir' | 'newfile' | 'rename' | 'delete'

export interface FileMutationDialogProps {
  kind: FileMutationKind
  targetName?: string
  targetPath?: string
  isTargetDir?: boolean
  busy?: boolean
  onSubmit: (value: string) => void
  onClose: () => void
}

const TITLES: Record<FileMutationKind, string> = {
  mkdir: 'New folder',
  newfile: 'New file',
  rename: 'Rename',
  delete: 'Delete'
}

const LABELS: Record<Exclude<FileMutationKind, 'delete'>, string> = {
  mkdir: 'Folder name',
  newfile: 'File name',
  rename: 'New name'
}

export default function FileMutationDialog({
  kind,
  targetName,
  targetPath,
  isTargetDir,
  busy = false,
  onSubmit,
  onClose
}: FileMutationDialogProps) {
  const [value, setValue] = useState(targetName ?? '')

  useEffect(() => {
    setValue(targetName ?? '')
  }, [targetName])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (busy) return
    onSubmit(value)
  }

  const canSubmit = kind === 'delete' ? true : value.trim().length > 0

  return (
    <ModalShell open onClose={onClose} title={TITLES[kind]} size={kind === 'delete' ? 'sm' : 'md'}>
      <form onSubmit={handleSubmit}>
        {kind === 'delete' ? (
          <p>
            Permanently delete <b>{targetName}</b>
            {targetPath ? ` at ${targetPath}` : ''}
            {isTargetDir ? ' and everything inside it' : ''}? This cannot be undone.
          </p>
        ) : (
          <label>
            {LABELS[kind]}
            <input
              autoFocus
              value={value}
              disabled={busy}
              onChange={(e) => setValue(e.target.value)}
            />
          </label>
        )}
        <div className="actions">
          <span className="spacer" />
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant={kind === 'delete' ? 'danger' : 'primary'}
            disabled={busy || !canSubmit}
          >
            {kind === 'delete' ? 'Delete' : kind === 'rename' ? 'Rename' : 'Create'}
          </Button>
        </div>
      </form>
    </ModalShell>
  )
}
