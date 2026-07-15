import { ipcMain, BrowserWindow } from 'electron'
import { IPC, type SSHProfile, type SSHStatus } from '@shared/types'
import { SSHManager, type ReconnectPolicy } from '../ssh/manager'
import { makeCoalescer } from './coalesce'
import { globalSearchIndex } from '../search/index'

export function registerSshIpc(getWindow: () => BrowserWindow | null): SSHManager {
  const send = (channel: string, ...args: unknown[]) => {
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
  }

  const sendData = makeCoalescer((id, data) => {
    // Feed live SSH shell output into the global search index. A push can
    // throw on a closed session (the index drops it); we never want a
    // search-index glitch to break the live SSH data path. Mirrors the PTY
    // path so remote output is searchable the same way local PTY output is.
    try {
      globalSearchIndex.pushLine(id, data)
    } catch {
      /* search index miss — keep streaming */
    }
    send(`${IPC.sshData}:${id}`, data)
  })
  const manager = new SSHManager({
    onData: (id, data) => sendData.push(id, data),
    onExit: (id) => {
      // Flush buffered shell output before the close event so the last bytes
      // can't arrive after the "connection closed" banner.
      sendData.flush(id)
      // Drop the session's lines from the global search index so a closed
      // remote session doesn't keep surfacing stale hits in the search
      // modal. The renderer's live xterm buffer is the only place the
      // recent output remains visible.
      globalSearchIndex.clearSession(id)
      send(`${IPC.sshExit}:${id}`)
    },
    onStatus: (id, status: SSHStatus) => send(`${IPC.sshStatus}:${id}`, status)
  })

  ipcMain.handle(IPC.sshConnect, (_e, profile: SSHProfile) => manager.connect(profile))
  ipcMain.handle(IPC.sshOpenShell, (_e, id: string, cols: number, rows: number) =>
    manager.openShell(id, cols, rows)
  )
  ipcMain.on(IPC.sshInput, (_e, id: string, data: string) => manager.input(id, data))
  ipcMain.on(IPC.sshResize, (_e, id: string, cols: number, rows: number) =>
    manager.resize(id, cols, rows)
  )
  ipcMain.on(IPC.sshDisconnect, (_e, id: string) => manager.disconnect(id))
  // Cancel an in-flight auto-reconnect loop; safe to call when nothing is scheduled.
  ipcMain.on(IPC.sshCancelReconnect, (_e, id: string) => manager.cancelReconnect(id))
  // Set/inspect the auto-reconnect policy. The renderer pushes its settings here
  // on boot and whenever the user edits them in the Settings modal.
  ipcMain.handle(IPC.sshGetReconnectPolicy, () => manager.getReconnectPolicy())
  ipcMain.handle(IPC.sshSetReconnectPolicy, (_e, patch: Partial<ReconnectPolicy>) => {
    manager.setReconnectPolicy(patch)
    return manager.getReconnectPolicy()
  })

  return manager
}
