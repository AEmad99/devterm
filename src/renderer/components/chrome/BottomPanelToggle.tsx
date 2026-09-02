import { IconActivity, IconClose, IconTransfer } from '../common/Icons'
import type { BottomPanelMode } from './types'

interface BottomPanelToggleProps {
  mode: BottomPanelMode
  setMode: (mode: BottomPanelMode) => void
}

const MODES: {
  id: BottomPanelMode
  label: string
  title: string
  icon: typeof IconActivity
}[] = [
  {
    id: 'activity',
    label: 'Activity',
    title: 'Show the agent activity panel',
    icon: IconActivity
  },
  {
    id: 'transfers',
    label: 'Transfers',
    title: 'Show the transfers panel',
    icon: IconTransfer
  },
  { id: 'off', label: 'Off', title: 'Hide the bottom dock', icon: IconClose }
]

export default function BottomPanelToggle({ mode, setMode }: BottomPanelToggleProps) {
  return (
    <div className="bottom-panel-toggle" role="group" aria-label="Bottom panel">
      {MODES.map((m) => {
        const Icon = m.icon
        return (
          <button
            key={m.id}
            type="button"
            aria-pressed={mode === m.id}
            aria-label={m.title}
            className={`seg ${mode === m.id ? 'active' : ''}`}
            onClick={() => setMode(m.id)}
            title={m.title}
          >
            <Icon size={14} />
            <span className="seg-label">{m.label}</span>
          </button>
        )
      })}
    </div>
  )
}
