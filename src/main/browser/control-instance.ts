import { BrowserWindow } from 'electron'
import { IPC, type BrowserOpenRequest } from '@shared/types'
import { BrowserControlService } from './control'

/**
 * Process-wide browser control registry. A lazy singleton because it must be
 * reachable from two independent consumers (window bootstrap registers its
 * IPC handlers; ipc/agent.ts hands it into every MCP bridge's ToolDeps) and
 * neither owns the other's lifecycle.
 */
let instance: BrowserControlService | null = null

export function browserControl(): BrowserControlService {
  if (!instance) {
    // Open requests broadcast to every window: the main window renders panes;
    // other windows (floating agent) simply have no listener. This mirrors
    // how confirms/PTY data fan out.
    instance = new BrowserControlService((req: BrowserOpenRequest) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send(IPC.browserControlRequest, req)
      }
    })
  }
  return instance
}
