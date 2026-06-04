import { ipcMain, BrowserWindow, screen } from 'electron'
import { IPC, type WindowSnapTarget } from '@shared/types'

const EDGE_SNAP_PX = 10
const EDGE_SNAP_SETTLE_MS = 120

let suppressEdgeSnapUntil = 0

function snapWindow(win: BrowserWindow, target: WindowSnapTarget): void {
  if (win.isDestroyed()) return
  const display = screen.getDisplayMatching(win.getBounds())
  const { x, y, width, height } = display.workArea
  suppressEdgeSnapUntil = Date.now() + 350

  if (target === 'maximize') {
    win.maximize()
    return
  }

  if (win.isMaximized()) win.unmaximize()
  const half = Math.floor(width / 2)
  const bounds =
    target === 'left'
      ? { x, y, width: half, height }
      : { x: x + half, y, width: width - half, height }
  win.setBounds(bounds, true)
}

function installEdgeSnap(win: BrowserWindow): void {
  let timer: NodeJS.Timeout | null = null
  const clear = () => {
    if (timer) clearTimeout(timer)
    timer = null
  }
  const maybeSnap = () => {
    timer = null
    if (
      win.isDestroyed() ||
      win.isMaximized() ||
      win.isMinimized() ||
      win.isFullScreen() ||
      Date.now() < suppressEdgeSnapUntil
    ) {
      return
    }
    const pt = screen.getCursorScreenPoint()
    const { workArea } = screen.getDisplayNearestPoint(pt)
    const nearTop = pt.y <= workArea.y + EDGE_SNAP_PX
    const nearLeft = pt.x <= workArea.x + EDGE_SNAP_PX
    const nearRight = pt.x >= workArea.x + workArea.width - EDGE_SNAP_PX

    if (nearTop) snapWindow(win, 'maximize')
    else if (nearLeft) snapWindow(win, 'left')
    else if (nearRight) snapWindow(win, 'right')
  }

  win.on('move', () => {
    if (Date.now() < suppressEdgeSnapUntil) return
    clear()
    timer = setTimeout(maybeSnap, EDGE_SNAP_SETTLE_MS)
  })
  win.on('closed', clear)
}

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
  const initial = getWin()
  if (initial) installEdgeSnap(initial)

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
  ipcMain.on(IPC.windowSnap, (_e, target: WindowSnapTarget) => {
    const win = getWin()
    if (!win) return
    snapWindow(win, target)
  })
  ipcMain.on(IPC.windowClose, () => getWin()?.close())
  ipcMain.handle(IPC.windowIsMaximized, () => !!getWin()?.isMaximized())
}
