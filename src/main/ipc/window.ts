import { ipcMain, BrowserWindow, Notification } from 'electron'
import { IPC } from '@shared/types'

/**
 * Window appearance IPC. The renderer asks for a translucent "glass" material
 * when the Glass theme is active. Real OS blur (Acrylic on Windows, vibrancy on
 * macOS) is only available via `BrowserWindow.setBackgroundMaterial`, added in
 * Electron 30 — this app is pinned to Electron 29 by the node-pty prebuilt ABI,
 * so the call is feature-detected and degrades to a no-op there. The window uses
 * the normal OS frame so Windows owns native snap and system window behavior.
 * When the Electron floor is raised, glass auto-upgrades to Acrylic.
 */
export function registerWindowIpc(getWin: () => BrowserWindow | null): void {
  ipcMain.handle(IPC.windowSetGlass, (_e, enabled: boolean) => {
    const win = getWin()
    if (!win || win.isDestroyed()) return
    const w = win as BrowserWindow & {
      setBackgroundMaterial?: (material: 'auto' | 'none' | 'mica' | 'acrylic' | 'tabbed') => void
    }
    if (typeof w.setBackgroundMaterial === 'function') {
      try {
        w.setBackgroundMaterial(enabled ? 'acrylic' : 'none')
      } catch {
        /* unsupported on this platform/build — CSS glass still applies */
      }
    }
    if (process.platform === 'darwin' && typeof win.setVibrancy === 'function') {
      win.setVibrancy(enabled ? 'under-window' : null)
    }
  })

  // Attention signal: when an agent/terminal wants the operator and the window
  // is in the background, flash the taskbar button and post an OS notification.
  // The renderer already decides *whether* to alert (it owns the active-session
  // / focus / debounce logic); main just performs the OS-level surfacing. Skip
  // it entirely when the window is focused — you can't flash a foreground window
  // and a toast would be redundant with the in-app chime + tab badge.
  ipcMain.on(IPC.windowFlashAttention, (_e, notice: { title: string; body?: string }) => {
    const win = getWin()
    if (!win || win.isDestroyed() || win.isFocused()) return
    // FLASHW_TIMERNOFG: flash until the window comes to the foreground (Windows
    // auto-clears it on activate); the focus listener below is a belt-and-braces.
    win.flashFrame(true)
    if (Notification.isSupported()) {
      const n = new Notification({
        title: notice.title || 'DevTerm',
        body: notice.body || '',
        // Stay silent: the audible alert is the in-app Web Audio chime, whose
        // loudness the user controls via the attention "Chime volume" slider. A
        // non-silent toast would play Windows' own notification ding at the fixed
        // system volume — which has no API to scale and ignores that slider — so
        // the volume setting would appear to do nothing. The toast itself and the
        // taskbar flash still surface; only the uncontrollable OS sound is dropped.
        silent: true
      })
      n.on('click', () => {
        const w = getWin()
        if (!w || w.isDestroyed()) return
        if (w.isMinimized()) w.restore()
        w.show()
        w.focus()
      })
      n.show()
    }
  })
}
