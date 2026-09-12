import TopNav from './TopNav'
import BottomPanelToggle from './BottomPanelToggle'
import Button from '../common/Button'
import Tooltip from '../common/Tooltip'
import { LogoMark, IconMenu, IconSettings, IconKeyboard } from '../common/Icons'
import { IconBranch } from '../git/GitIcons'
import MicButton from '../dictation/MicButton'
import { useActiveGitStatus, gitChangeCount } from '../../lib/use-git-status'
import type { HostContext } from '@shared/types'
import type { HotkeyId } from '../../lib/hotkeys'
import type { View, BottomPanelMode } from './types'

interface AppToolbarProps {
  view: View
  setView: (view: View) => void
  setShowSidebar: (v: boolean | ((prev: boolean) => boolean)) => void
  sidebarOpen: boolean
  bottomPanelMode: BottomPanelMode
  setBottomPanelMode: (mode: BottomPanelMode) => void
  local?: HostContext | null
  gitPanelOpen: boolean
  setGitPanelOpen: (v: boolean | ((prev: boolean) => boolean)) => void
  onSettings: () => void
  onShortcuts: () => void
  dictateHotkey?: string
  /** Resolve a hotkey id to its display label (for tooltips). */
  hotkeyLabel?: (id: HotkeyId) => string
}

export default function AppToolbar({
  view,
  setView,
  setShowSidebar,
  sidebarOpen,
  bottomPanelMode,
  setBottomPanelMode,
  gitPanelOpen,
  setGitPanelOpen,
  onSettings,
  onShortcuts,
  dictateHotkey,
  hotkeyLabel
}: AppToolbarProps) {
  const git = useActiveGitStatus()
  const changes = gitChangeCount(git)
  const hotkey = (id: HotkeyId) => hotkeyLabel?.(id) || undefined

  return (
    <div className="titlebar">
      <Tooltip tip={sidebarOpen ? 'Hide file explorer' : 'Show file explorer'} pos="bottom">
        <Button
          variant="icon"
          aria-label="Toggle file explorer"
          aria-expanded={sidebarOpen}
          onClick={() => setShowSidebar((v) => !v)}
        >
          <IconMenu size={16} />
        </Button>
      </Tooltip>
      <span className="brand" aria-label="DevTerm">
        <LogoMark size={18} />
        <span className="brand-name">DevTerm</span>
      </span>
      <TopNav view={view} setView={setView} />
      <span className="spacer" />
      <Tooltip
        tip={
          git?.isRepo
            ? `Git panel — ${git.branch || 'detached'}${changes ? ` · ${changes} changed` : ' · clean'}`
            : 'Toggle Git panel'
        }
        hotkey={hotkey('toggleGit')}
        pos="bottom"
      >
        <Button
          variant="icon"
          className="has-badge"
          active={gitPanelOpen}
          aria-label="Toggle Git panel"
          onClick={() => setGitPanelOpen((v) => !v)}
        >
          <IconBranch size={16} />
          {changes > 0 && (
            <span className="toolbar-badge" aria-hidden="true">
              {changes > 99 ? '99+' : changes}
            </span>
          )}
        </Button>
      </Tooltip>
      <BottomPanelToggle mode={bottomPanelMode} setMode={setBottomPanelMode} />
      <span className="toolbar-sep" aria-hidden="true" />
      <MicButton hotkey={dictateHotkey} />
      <span className="toolbar-sep" aria-hidden="true" />
      <Tooltip tip="Keyboard shortcuts" hotkey={hotkey('shortcuts')} pos="bottom">
        <Button variant="icon" aria-label="Keyboard shortcuts" onClick={onShortcuts}>
          <IconKeyboard size={16} />
        </Button>
      </Tooltip>
      <Tooltip tip="Settings" hotkey={hotkey('settings')} pos="bottom">
        <Button variant="icon" aria-label="Settings" onClick={onSettings}>
          <IconSettings size={16} />
        </Button>
      </Tooltip>
    </div>
  )
}
