import Tooltip from '../common/Tooltip'
import { IconFolder, IconGroup, IconKeyboard, IconRemote } from '../common/Icons'
import type { LibraryId } from './types'

const ITEMS: { id: LibraryId; label: string; icon: typeof IconFolder }[] = [
  { id: 'files', label: 'Files', icon: IconFolder },
  { id: 'connections', label: 'Connections', icon: IconRemote },
  { id: 'workspaces', label: 'Workspaces', icon: IconGroup },
  { id: 'snippets', label: 'Snippets', icon: IconKeyboard }
]

/**
 * Icon rail for the library panels. The terminal stays mounted beside whichever
 * panel is open; clicking the active icon closes it.
 */
export default function SideRail({
  active,
  onToggle,
  filesHotkey
}: {
  active: LibraryId | null
  onToggle: (id: LibraryId) => void
  filesHotkey?: string
}) {
  return (
    <nav className="side-rail" aria-label="Library">
      {ITEMS.map((item) => {
        const Icon = item.icon
        const on = active === item.id
        const tip = on ? `Hide ${item.label.toLowerCase()}` : item.label
        return (
          <Tooltip
            key={item.id}
            tip={tip}
            hotkey={item.id === 'files' ? filesHotkey : undefined}
            pos="right"
          >
            <button
              type="button"
              className={on ? 'active' : ''}
              aria-label={item.label}
              aria-pressed={on}
              onClick={() => onToggle(item.id)}
            >
              <Icon size={16} />
            </button>
          </Tooltip>
        )
      })}
    </nav>
  )
}
