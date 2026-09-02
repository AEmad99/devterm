import type { View } from './types'

interface TopNavProps {
  view: View
  setView: (view: View) => void
}

const ITEMS: { id: View; label: string }[] = [
  { id: 'terminals', label: 'Terminals' },
  { id: 'connections', label: 'Connections' },
  { id: 'workspaces', label: 'Workspaces' },
  { id: 'snippets', label: 'Snippets' }
]

export default function TopNav({ view, setView }: TopNavProps) {
  return (
    <nav className="top-nav" aria-label="Views">
      {ITEMS.map((item) => (
        <button
          key={item.id}
          type="button"
          aria-current={view === item.id ? 'page' : undefined}
          className={view === item.id ? 'active' : ''}
          onClick={() => setView(item.id)}
        >
          {item.label}
        </button>
      ))}
    </nav>
  )
}
