import { ipcMain } from 'electron'
import os from 'os'
import { IPC, type HostContext, type HostOS } from '@shared/types'

function localOS(): HostOS {
  switch (process.platform) {
    case 'win32':
      return 'windows'
    case 'darwin':
      return 'mac'
    case 'linux':
      return 'linux'
    default:
      return 'unknown'
  }
}

export function registerContextIpc(): void {
  ipcMain.handle(IPC.localContext, (): HostContext => ({
    kind: 'local',
    os: localOS(),
    detail: `${os.type()} ${os.release()} (${os.arch()})`,
    hostname: os.hostname()
  }))
}
