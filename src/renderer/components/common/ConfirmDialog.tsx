import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import ModalShell from './ModalShell'

export interface ConfirmDialogProps {
  open: boolean
  title: string
  message: ReactNode
  confirmLabel?: string
  /** Danger styling on the confirm button (default true); false → primary. */
  danger?: boolean
  onConfirm: () => void
  onClose: () => void
}

/**
 * The house "are you sure?" dialog — a small ModalShell with a Cancel ghost
 * and a danger confirm (the same `ghost` / `danger` classes SettingsModal and
 * FilePane use). Esc and overlay-click close via ModalShell; the confirm
 * button is autofocused on open so Enter accepts.
 */
export default function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Delete',
  danger = true,
  onConfirm,
  onClose
}: ConfirmDialogProps) {
  const confirmRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (open) confirmRef.current?.focus()
  }, [open])

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <>
          <button type="button" className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            ref={confirmRef}
            type="button"
            className={danger ? 'danger' : 'primary'}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      {message}
    </ModalShell>
  )
}
