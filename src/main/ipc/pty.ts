import { ipcMain, BrowserWindow } from 'electron'
import { IPC, type PtyCreateOptions } from '@shared/types'
import { PtyManager } from '../pty/manager'
import { makeCoalescer } from './coalesce'
import { globalSearchIndex } from '../search/index'

/**
 * Registers PTY IPC handlers. Data/exit events are pushed to the renderer on
 * per-pty channels (`pty:data:<id>`) so multiple panes don't cross-talk.
 */
export function registerPtyIpc(getWindow: () => BrowserWindow | null): PtyManager {
  const send = (channel: string, ...args: unknown[]) => {
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
  }

  const sendData = makeCoalescer((id, data) => {
    // Feed live PTY output into global search index (MVP: split per line).
    // A push can throw on a closed session (the index drops it); we never
    // want a search-index glitch to break the live PTY data path.
    try {
      globalSearchIndex.pushLine(id, data)
    } catch {
      /* search index miss — keep streaming */
    }
    send(`${IPC.ptyData}:${id}`, data)
  })
  const manager = new PtyManager({
    onData: (id, data) => sendData.push(id, data),
    onExit: (id, exitCode, signal) => {
      // Flush any buffered output for this pty first so the exit event can't
      // overtake the process's final bytes still sitting in the coalescer.
      sendData.flush(id)
      send(`${IPC.ptyExit}:${id}`, { exitCode, signal })
    },
    onStartupFailure: (id, info) => {
      // Fired when a shell exits within the startup health window without
      // ever producing data — the Windows PowerShell 5.1 0x8009001d case is
      // the canonical example. Pushed to the renderer so its TerminalView can
      // render a targeted diagnostic instead of the generic exit banner.
      // Independent of the regular exit event; both fire.
      send(`${IPC.ptyStartupFailure}:${id}`, info)
    }
  })

  ipcMain.handle(IPC.ptyCreate, (_e, opts: PtyCreateOptions) => manager.create(opts))
  ipcMain.on(IPC.ptyInput, (_e, id: string, data: string) => manager.input(id, data))
  ipcMain.on(IPC.ptyResize, (_e, id: string, cols: number, rows: number) =>
    manager.resize(id, cols, rows)
  )
  ipcMain.on(IPC.ptyKill, (_e, id: string) => manager.kill(id))

  return manager
}
