import TopNav from './TopNav'
import BottomPanelToggle from './BottomPanelToggle'
import { LogoMark, IconMenu, IconSettings, IconKeyboard } from '../common/Icons'
import { IconBranch } from '../git/GitIcons'
import MicButton from '../dictation/MicButton'
import type { HostContext } from '@shared/types'
import type { View, BottomPanelMode } from './types'

function osLabel(os?: string): string {
  switch (os) {
    case 'windows':
      return 'Windows'
    case 'linux':
      return 'Linux'
    case 'mac':
      return 'macOS'
    default:
      return 'unknown'
  }
}

interface AppToolbarProps {
  view: View
  setView: (view: View) => void
  setShowSidebar: (v: boolean | ((prev: boolean) => boolean)) => void
  bottomPanelMode: BottomPanelMode
  setBottomPanelMode: (mode: BottomPanelMode) => void
  local: HostContext | null
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
  bottomPanelMode,
  setBottomPanelMode,
  local,
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
        onClick={() => setShowSidebar((v) => !v)}
      >
        <IconMenu size={17} />
      </button>
      <span className="brand">
        <LogoMark size={20} />
        <span className="brand-name">DevTerm</span>
      </span>
      <span className="badge">{local ? `${local.hostname} · ${osLabel(local.os)}` : ''}</span>
      <TopNav view={view} setView={setView} />
      <span className="spacer" />
      <button
        className={`settings-btn ${gitPanelOpen ? 'active' : ''}`}
        title="Toggle Git panel (branches, log, changes, stash, tags, remotes)"
        aria-pressed={gitPanelOpen}
        onClick={() => setGitPanelOpen((v) => !v)}
      >
        <IconBranch size={17} />
      </button>
      <BottomPanelToggle mode={bottomPanelMode} setMode={setBottomPanelMode} />
      <MicButton hotkey={dictateHotkey} />
      <button
        className="settings-btn"
        title="Keyboard shortcuts (Ctrl/Cmd+/)"
        onClick={onShortcuts}
      >
        <IconKeyboard size={17} />
      </button>
      <button className="settings-btn" title="Settings" onClick={onSettings}>
        <IconSettings size={17} />
      </button>
    </div>
  )
}
