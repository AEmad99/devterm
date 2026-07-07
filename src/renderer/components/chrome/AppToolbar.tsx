import TopNav from './TopNav'
import BottomPanelToggle from './BottomPanelToggle'
import { LogoMark, IconMenu, IconSettings, IconKeyboard } from '../common/Icons'
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
  onSettings: () => void
  onShortcuts: () => void
}

export default function AppToolbar({
  view,
  setView,
  setShowSidebar,
  bottomPanelMode,
  setBottomPanelMode,
  local,
  onSettings,
  onShortcuts
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
      <BottomPanelToggle mode={bottomPanelMode} setMode={setBottomPanelMode} />
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
