import { ipcMain } from 'electron'
import { IPC, type SSHProfile } from '@shared/types'
import { broadcast } from './broadcast'
import type { RdpStatus } from '@shared/types'
import { RdpManager } from '../rdp/manager'

export function registerRdpIpc(): RdpManager {
  const manager = new RdpManager((id, status: RdpStatus) => {
    broadcast(`${IPC.rdpStatus}:${id}`, status)
  })
  ipcMain.handle(IPC.rdpConnect, (_e, profile: SSHProfile) => manager.connect(profile))
  ipcMain.on(IPC.rdpDisconnect, (_e, id: string) => manager.disconnect(id))
  ipcMain.on(IPC.rdpFocus, (_e, id: string) => manager.focus(id))
  return manager
}

