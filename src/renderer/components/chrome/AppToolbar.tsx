import TopNav from './TopNav'
import BottomPanelToggle from './BottomPanelToggle'
import { LogoMark, IconMenu, IconSettings, IconKeyboard } from '../common/Icons'
import { IconBranch } from '../git/GitIcons'
import MicButton from '../dictation/MicButton'
import type { HostContext } from '@shared/types'
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
  dictateHotkey
}: AppToolbarProps) {
  return (
    <div className="titlebar">
      <button
        className="sidebar-toggle"
        title="Toggle file explorer"
        aria-label="Toggle file explorer"
        aria-expanded={sidebarOpen}
        onClick={() => setShowSidebar((v) => !v)}
      >
        <IconMenu size={16} />
      </button>
      <span className="brand" aria-label="DevTerm">
        <LogoMark size={18} />
        <span className="brand-name">DevTerm</span>
      </span>
      <TopNav view={view} setView={setView} />
      <span className="spacer" />
      <button
        className={`settings-btn ${gitPanelOpen ? 'active' : ''}`}
        title="Toggle Git panel"
        aria-label="Toggle Git panel"
        aria-pressed={gitPanelOpen}
        onClick={() => setGitPanelOpen((v) => !v)}
      >
        <IconBranch size={16} />
      </button>
      <BottomPanelToggle mode={bottomPanelMode} setMode={setBottomPanelMode} />
      <MicButton hotkey={dictateHotkey} />
      <button
        className="settings-btn"
        title="Keyboard shortcuts (Ctrl/Cmd+/)"
        aria-label="Keyboard shortcuts"
        onClick={onShortcuts}
      >
        <IconKeyboard size={16} />
      </button>
      <button className="settings-btn" title="Settings" aria-label="Settings" onClick={onSettings}>
        <IconSettings size={16} />
      </button>
    </div>
  )
}
