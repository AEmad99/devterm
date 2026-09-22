import Button from '../common/Button'
import Tooltip from '../common/Tooltip'
import { LogoMark, IconKeyboard, IconSettings } from '../common/Icons'
import { IconBranch } from '../git/GitIcons'
import MicButton from '../dictation/MicButton'
import { useActiveGitStatus, gitChangeCount } from '../../lib/use-git-status'
import type { HotkeyId } from '../../lib/hotkeys'

interface AppToolbarProps {
  gitPanelOpen: boolean
  setGitPanelOpen: (v: boolean | ((prev: boolean) => boolean)) => void
  onSettings: () => void
  onShortcuts: () => void
  dictateHotkey?: string
  /** Resolve a hotkey id to its display label (for tooltips). */
  hotkeyLabel?: (id: HotkeyId) => string
}

export default function AppToolbar({
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
      <span className="brand" aria-label="DevTerm">
        <LogoMark size={18} />
        <span className="brand-name">DevTerm</span>
      </span>
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
