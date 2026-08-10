import { BrowserWindow } from 'electron'

/**
 * Send an IPC event to every live BrowserWindow (main + floating agent windows).
 * Used for PTY streams, bridge status, confirms, and activity so a pop-out
 * agent window stays in sync with the main app.
 */
export function broadcast(channel: string, ...args: unknown[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    try {
      win.webContents.send(channel, ...args)
    } catch {
      /* window tearing down */
    }
  }
}
