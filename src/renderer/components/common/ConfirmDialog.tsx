import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import ModalShell from './ModalShell'
import Button from './Button'

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
 * House confirm dialog. Cancel is focused on destructive confirms so Enter
 * does not immediately kill. Esc / overlay-click close via ModalShell.
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
  const cancelRef = useRef<HTMLButtonElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const target = danger ? cancelRef.current : confirmRef.current
    target?.focus()
  }, [open, danger])

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <>
          <Button ref={cancelRef} variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button ref={confirmRef} variant={danger ? 'danger' : 'primary'} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {message}
    </ModalShell>
  )
}
