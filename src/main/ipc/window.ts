import { ipcMain, app, BrowserWindow, Notification } from 'electron'
import { IPC } from '@shared/types'
import { resolveAppIconPath } from '../app-icon'

/** Set by the renderer whenever editor buffers gain/lose unsaved changes. */
let unsavedEditors = false

/**
 * True when the renderer reports unsaved editor buffers. The main-process
 * window-close guard reads this alongside running agents.
 */
export function hasUnsavedEditors(): boolean {
  return unsavedEditors
}

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
  ipcMain.on(
    IPC.windowFlashAttention,
    (_e, notice: { title: string; body?: string; sessionId?: string }) => {
      const win = getWin()
      if (!win || win.isDestroyed() || win.isFocused()) return
      raiseAttention(win, notice)
    }
  )

  // A floating agent window finished a turn. The float renderer has no session
  // store of its own, so it reports here: main raises the OS signal and tells
  // the main window to badge the session's tab.
  ipcMain.on(
    IPC.windowAgentAttention,
    (_e, sessionId: string, notice: { title: string; body?: string }) => {
      if (typeof sessionId !== 'string' || !sessionId) return
      const win = getWin()
      if (!win || win.isDestroyed()) return
      win.webContents.send(IPC.windowAgentAttention, { sessionId, notice })
      if (!win.isFocused()) raiseAttention(win, { ...notice, sessionId })
    }
  )

  // The renderer reports whether unsaved editor buffers exist so the
  // window-close guard can include them in its confirmation.
  ipcMain.on(IPC.appCloseGuard, (_e, hasUnsaved: boolean) => {
    unsavedEditors = hasUnsaved === true
  })
}

/**
 * Shared OS-level surfacing: taskbar flash (until foreground) + a silent toast.
 * Clicking the toast focuses the window and, when the notice carries a
 * sessionId, asks the renderer to focus that exact session.
 */
function raiseAttention(
  win: BrowserWindow,
  notice: { title: string; body?: string; sessionId?: string }
): void {
  // FLASHW_TIMERNOFG: flash until the window comes to the foreground (Windows
  // auto-clears it on activate); the focus listener in index.ts is belt-and-braces.
  win.flashFrame(true)
  // Persistent badge where the platform supports it (dock/taskbar); cleared on
  // window focus in index.ts.
  try {
    app.setBadgeCount(1)
  } catch {
    /* unsupported platform */
  }
  if (Notification.isSupported()) {
    const n = new Notification({
      title: notice.title || 'DevTerm',
      body: notice.body || '',
      icon: resolveAppIconPath(),
      // Stay silent: the audible alert is the in-app Web Audio chime, whose
      // loudness the user controls via the attention "Chime volume" slider. A
      // non-silent toast would play Windows' own notification ding at the fixed
      // system volume — which has no API to scale and ignores that slider — so
      // the volume setting would appear to do nothing. The toast itself and the
      // taskbar flash still surface; only the uncontrollable OS sound is dropped.
      silent: true
    })
    n.on('click', () => {
      if (win.isDestroyed()) return
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
      if (notice.sessionId) win.webContents.send(IPC.windowFocusSession, notice.sessionId)
    })
    n.show()
  }
}
