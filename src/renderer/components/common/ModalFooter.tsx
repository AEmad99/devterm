import type { ReactNode } from 'react'

interface ModalFooterProps {
  /** Trailing (right) buttons: secondary first, primary last. */
  children: ReactNode
  /** Leading (left) content: checkboxes, "New", destructive secondary. */
  start?: ReactNode
}

/**
 * House modal-footer layout: optional leading content, spacer, then the
 * trailing action cluster (secondary → primary). Use for every new modal
 * footer so Cancel/Save order and alignment stay consistent.
 */
export default function ModalFooter({ children, start }: ModalFooterProps) {
  return (
    <>
      {start}
      <span className="spacer" />
      {children}
    </>
  )
}
