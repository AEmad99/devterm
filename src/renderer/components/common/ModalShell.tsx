import { useEffect, useId } from 'react'
import type { ReactNode } from 'react'

export interface ModalShellProps {
  open: boolean
  onClose: () => void
  title?: ReactNode
  size?: 'sm' | 'md' | 'lg' | 'xl'
  children: ReactNode
  footer?: ReactNode
  className?: string
}

export default function ModalShell({
  open,
  onClose,
  title,
  size = 'md',
  children,
  footer,
  className = ''
}: ModalShellProps) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const titleId = useId()

  if (!open) return null

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className={['modal', `modal--${size}`, className].filter(Boolean).join(' ')}
        role="dialog"
        aria-modal="true"
        {...(typeof title === 'string'
          ? { 'aria-label': title }
          : title !== undefined
            ? { 'aria-labelledby': titleId }
            : {})}
        onClick={(e) => e.stopPropagation()}
      >
        {title !== undefined && (
          <div className="modal-head">
            <h3 id={titleId}>{title}</h3>
            <button type="button" className="modal-x" onClick={onClose} aria-label="Close">
              ×
            </button>
          </div>
        )}
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot actions">{footer}</div>}
      </div>
    </div>
  )
}
