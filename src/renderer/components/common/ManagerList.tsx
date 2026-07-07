import type { ReactNode } from 'react'

export interface ManagerListProps {
  children: ReactNode
  className?: string
}

export default function ManagerList({ children, className = '' }: ManagerListProps) {
  return <div className={`manager-list ${className}`.trim()}>{children}</div>
}
