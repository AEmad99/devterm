import type { ReactNode } from 'react'

export interface ManagerListProps {
  children: ReactNode
  className?: string
}

export default function ManagerList({ children, className = '' }: ManagerListProps) {
  return <div className={`manager-list ${className}`.trim()}>{children}</div>
}

/**
 * Loading placeholder for manager lists: shimmer rows in the same shape as
 * ManagerRow so the list doesn't jump when data arrives.
 */
export function ManagerSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="manager-list" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="manager-row skeleton-row">
          <div className="sk sk-icon" />
          <div className="mr-main">
            <div className="sk sk-line sk-w40" />
            <div className="sk sk-line sk-w70" />
          </div>
          <div className="sk sk-btn" />
        </div>
      ))}
    </div>
  )
}
