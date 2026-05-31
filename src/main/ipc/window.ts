import { ipcMain, BrowserWindow } from 'electron'
import { IPC } from '@shared/types'

/**
 * Window appearance IPC. The renderer asks for a translucent "glass" material
 * when the Glass theme is active. Real OS blur (Acrylic on Windows, vibrancy on
 * macOS) is only available via `BrowserWindow.setBackgroundMaterial`, added in
 * Electron 30 — this app is pinned to Electron 29 by the node-pty prebuilt ABI,
 * so the call is feature-detected and degrades to a no-op there (the renderer's
 * CSS glass layer + the window's `transparent: true` still deliver see-through
 * surfaces). When the Electron floor is raised, glass auto-upgrades to Acrylic.
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

  // Custom titlebar controls — the window is frameless (so the Glass theme can be
  // truly transparent on Windows), so min/maximize/close are driven from the UI.
  ipcMain.on(IPC.windowMinimize, () => getWin()?.minimize())
  ipcMain.on(IPC.windowToggleMaximize, () => {
    const win = getWin()
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.on(IPC.windowClose, () => getWin()?.close())
  ipcMain.handle(IPC.windowIsMaximized, () => !!getWin()?.isMaximized())
}
