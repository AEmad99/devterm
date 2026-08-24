import { ipcMain } from 'electron'
import { IPC, type BrowserControlTabInfo, type BrowserControlTabPatch } from '@shared/types'
import type { BrowserControlService } from '../browser/control'

/**
 * Renderer ↔ main plumbing for agent browser control. The renderer reports
 * every browser tab's lifecycle (register/update/unregister); the service's
 * request sender is injected at construction so ipc/browser-control.ts stays
 * a thin adapter.
 */
export function registerBrowserControlIpc(service: BrowserControlService): void {
  ipcMain.handle(IPC.browserControlRegister, (_e, info: BrowserControlTabInfo) => {
    if (info && typeof info.tabKey === 'string' && typeof info.paneSessionId === 'string') {
      service.register(info)
    }
  })
  ipcMain.on(IPC.browserControlUnregister, (_e, tabKey: string) => {
    if (typeof tabKey === 'string') service.unregister(tabKey)
  })
  ipcMain.on(IPC.browserControlUpdate, (_e, tabKey: string, patch: BrowserControlTabPatch) => {
    if (
      typeof tabKey === 'string' &&
      patch &&
      (typeof patch.url === 'string' || typeof patch.title === 'string')
    ) {
      service.updateMeta(tabKey, {
        url: typeof patch.url === 'string' ? patch.url : undefined,
        title: typeof patch.title === 'string' ? patch.title : undefined
      })
    }
  })
}
