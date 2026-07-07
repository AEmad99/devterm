import type { BottomPanelMode } from './types'

interface BottomPanelToggleProps {
  mode: BottomPanelMode
  setMode: (mode: BottomPanelMode) => void
}

const MODES: { id: BottomPanelMode; label: string; title: string }[] = [
  {
    id: 'activity',
    label: 'Activity',
    title: 'Show the agent activity panel in the bottom dock'
  },
  {
    id: 'transfers',
    label: 'Transfers',
    title: 'Show the transfers panel in the bottom dock'
  },
  { id: 'off', label: 'Off', title: 'Hide the bottom dock panels' }
]

export default function BottomPanelToggle({ mode, setMode }: BottomPanelToggleProps) {
  return (
    <div className="bottom-panel-toggle" role="tablist" aria-label="Bottom panel">
      {MODES.map((m) => (
        <button
          key={m.id}
          role="tab"
          aria-selected={mode === m.id}
          className={`seg ${mode === m.id ? 'active' : ''}`}
          onClick={() => setMode(m.id)}
          title={m.title}
        >
          {m.label}
        </button>
      ))}
    </div>
  )
}
