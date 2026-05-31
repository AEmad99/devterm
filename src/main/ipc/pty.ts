import { ipcMain, BrowserWindow } from 'electron'
import { IPC, type PtyCreateOptions } from '@shared/types'
import { PtyManager } from '../pty/manager'
import { makeCoalescer } from './coalesce'

/**
 * Registers PTY IPC handlers. Data/exit events are pushed to the renderer on
 * per-pty channels (`pty:data:<id>`) so multiple panes don't cross-talk.
 */
export function registerPtyIpc(getWindow: () => BrowserWindow | null): PtyManager {
  const send = (channel: string, ...args: unknown[]) => {
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
  }

  const sendData = makeCoalescer((id, data) => send(`${IPC.ptyData}:${id}`, data))
  const manager = new PtyManager({
    onData: (id, data) => sendData(id, data),
    onExit: (id, exitCode, signal) => send(`${IPC.ptyExit}:${id}`, { exitCode, signal })
  })

  ipcMain.handle(IPC.ptyCreate, (_e, opts: PtyCreateOptions) => manager.create(opts))
  ipcMain.on(IPC.ptyInput, (_e, id: string, data: string) => manager.input(id, data))
  ipcMain.on(IPC.ptyResize, (_e, id: string, cols: number, rows: number) =>
    manager.resize(id, cols, rows)
  )
  ipcMain.on(IPC.ptyKill, (_e, id: string) => manager.kill(id))

  return manager
}
