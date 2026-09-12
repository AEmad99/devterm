import type { ReactNode } from 'react'

export interface ManagerRowProps {
  icon: ReactNode
  title?: ReactNode
  subtitle?: ReactNode
  meta?: ReactNode
  /** Primary actions — always visible (e.g. Connect, Run, Launch). */
  actions?: ReactNode
  /**
   * Secondary actions — revealed on row hover / keyboard focus so the list
   * stays quiet at rest (e.g. Edit, Duplicate, Delete, Pin).
   */
  secondaryActions?: ReactNode
  /** Double-click the row body (e.g. connect / run / launch). */
  onDoubleClick?: () => void
  className?: string
}

export default function ManagerRow({
  icon,
  title,
  subtitle,
  meta,
  actions,
  secondaryActions,
  onDoubleClick,
  className = ''
}: ManagerRowProps) {
  return (
    <div
      className={`manager-row ${className}`.trim()}
      onDoubleClick={
        onDoubleClick
          ? (e) => {
              // Double-clicks that start on an action button belong to the
              // button, not the row.
              if ((e.target as HTMLElement).closest('button')) return
              onDoubleClick()
            }
          : undefined
      }
    >
      <div className="mr-icon">{icon}</div>
      <div className="mr-main">
        {title !== undefined && <div className="mr-name">{title}</div>}
        {subtitle !== undefined && <div className="mr-sub">{subtitle}</div>}
        {meta}
      </div>
      {actions !== undefined && <div className="mr-actions">{actions}</div>}
      {secondaryActions !== undefined && (
        <div className="mr-actions mr-secondary">{secondaryActions}</div>
      )}
    </div>
  )
}
