import Button from '../common/Button'
import Tooltip from '../common/Tooltip'
import { IconFolder, IconGroup, IconKeyboard, IconRemote, IconSettings } from '../common/Icons'
import { IconBranch } from '../git/GitIcons'
import MicButton from '../dictation/MicButton'
import { gitChangeCount, useActiveGitStatus } from '../../lib/use-git-status'
import type { HotkeyId } from '../../lib/hotkeys'
import type { LibraryId } from './types'

const ITEMS: { id: LibraryId; label: string; icon: typeof IconFolder }[] = [
  { id: 'files', label: 'Files', icon: IconFolder },
  { id: 'connections', label: 'Connections', icon: IconRemote },
  { id: 'workspaces', label: 'Workspaces', icon: IconGroup },
  { id: 'snippets', label: 'Snippets', icon: IconKeyboard }
]

/**
 * Full-height icon rail beside the terminals. Library panels stay at the top;
 * Git, dictation, shortcuts, and settings sit at the bottom so the window has
 * no title bar and the terminal area can use that height.
 */
export default function SideRail({
  active,
  onToggle,
  filesHotkey,
  gitPanelOpen,
  onToggleGit,
  onSettings,
  onShortcuts,
  dictateHotkey,
  hotkeyLabel
}: {
  active: LibraryId | null
  onToggle: (id: LibraryId) => void
  filesHotkey?: string
  gitPanelOpen: boolean
  onToggleGit: () => void
  onSettings: () => void
  onShortcuts: () => void
  dictateHotkey?: string
  hotkeyLabel?: (id: HotkeyId) => string
}) {
  const git = useActiveGitStatus()
  const changes = gitChangeCount(git)
  const hotkey = (id: HotkeyId) => hotkeyLabel?.(id) || undefined

  return (
    <nav className="side-rail" aria-label="Sidebar">
      <div className="side-rail-library" role="group" aria-label="Library">
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
      </div>
      <div className="side-rail-utilities" role="group" aria-label="App actions">
        <span className="side-rail-sep" aria-hidden="true" />
        <Tooltip
          tip={
            git?.isRepo
              ? `Git panel — ${git.branch || 'detached'}${
                  changes ? ` · ${changes} changed` : ' · clean'
                }`
              : 'Toggle Git panel'
          }
          hotkey={hotkey('toggleGit')}
          pos="right"
        >
          <Button
            variant="icon"
            className="has-badge"
            active={gitPanelOpen}
            aria-label="Toggle Git panel"
            onClick={onToggleGit}
          >
            <IconBranch size={16} />
            {changes > 0 && (
              <span className="toolbar-badge" aria-hidden="true">
                {changes > 99 ? '99+' : changes}
              </span>
            )}
          </Button>
        </Tooltip>
        <MicButton hotkey={dictateHotkey} pos="right" />
        <Tooltip tip="Keyboard shortcuts" hotkey={hotkey('shortcuts')} pos="right">
          <Button variant="icon" aria-label="Keyboard shortcuts" onClick={onShortcuts}>
            <IconKeyboard size={16} />
          </Button>
        </Tooltip>
        <Tooltip tip="Settings" hotkey={hotkey('settings')} pos="right">
          <Button variant="icon" aria-label="Settings" onClick={onSettings}>
            <IconSettings size={16} />
          </Button>
        </Tooltip>
      </div>
    </nav>
  )
}
