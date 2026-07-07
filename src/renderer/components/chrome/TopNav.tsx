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
    <nav className="top-nav" role="tablist" aria-label="Top views">
      {ITEMS.map((item) => (
        <button
          key={item.id}
          role="tab"
          aria-selected={view === item.id}
          className={view === item.id ? 'active' : ''}
          onClick={() => setView(item.id)}
        >
          {item.label}
        </button>
      ))}
    </nav>
  )
}
