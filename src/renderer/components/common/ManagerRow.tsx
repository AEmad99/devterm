import type { ReactNode } from 'react'

export interface ManagerRowProps {
  icon: ReactNode
  title?: ReactNode
  subtitle?: ReactNode
  meta?: ReactNode
  actions?: ReactNode
  className?: string
}

export default function ManagerRow({
  icon,
  title,
  subtitle,
  meta,
  actions,
  className = ''
}: ManagerRowProps) {
  return (
    <div className={`manager-row ${className}`.trim()}>
      <div className="mr-icon">{icon}</div>
      <div className="mr-main">
        {title !== undefined && <div className="mr-name">{title}</div>}
        {subtitle !== undefined && <div className="mr-sub">{subtitle}</div>}
        {meta}
      </div>
      {actions !== undefined && <div className="mr-actions">{actions}</div>}
    </div>
  )
}
