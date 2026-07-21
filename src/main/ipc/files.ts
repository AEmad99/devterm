import { ipcMain, BrowserWindow } from 'electron'
import { IPC } from '@shared/types'
import {
  listLocal,
  localHome,
  mkdirLocal,
  createFileLocal,
  renameLocal,
  deleteLocal,
  readFileLocal,
  writeFileLocal
} from '../fs/local'
import {
  listRemote,
  sftpHome,
  mkdirRemote,
  createFileRemote,
  renameRemote,
  deleteRemote,
  readFileRemote,
  writeFileRemote
} from '../ssh/sftp'
import { FsWatchManager } from '../fs/watch'
import { SftpWatchManager } from '../ssh/watch'
import type { SSHManager } from '../ssh/manager'

export interface FileController {
  /** Stop every live directory watch (on quit). */
  stopWatches: () => void
}

export function registerFileIpc(
  ssh: SSHManager,
  getWindow: () => BrowserWindow | null
): FileController {
  const send = (channel: string, ...args: unknown[]) => {
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
  }

  // Local filesystem
  ipcMain.handle(IPC.fsList, (_e, path?: string) => listLocal(path))
  ipcMain.handle(IPC.fsHome, () => localHome())
  ipcMain.handle(IPC.fsMkdir, (_e, p: string) => mkdirLocal(p))
  ipcMain.handle(IPC.fsCreateFile, (_e, p: string) => createFileLocal(p))
  ipcMain.handle(IPC.fsRename, (_e, from: string, to: string) => renameLocal(from, to))
  ipcMain.handle(IPC.fsDelete, (_e, p: string) => deleteLocal(p))
  ipcMain.handle(IPC.fsReadFile, (_e, p: string) => readFileLocal(p))
  ipcMain.handle(IPC.fsWriteFile, (_e, p: string, content: string) => writeFileLocal(p, content))

  // Live directory watching: the renderer subscribes to a path and gets a fresh
  // listing pushed whenever the directory's contents change — no manual refresh.
  const fsWatcher = new FsWatchManager((id, listing) => send(`${IPC.fsWatchEvent}:${id}`, listing))
  const fsWatchesBySender = new Map<number, Set<string>>()
  ipcMain.handle(IPC.fsWatch, async (e, p: string) => {
    const id = await fsWatcher.start(p)
    trackWatch(e.sender, fsWatchesBySender, id, (wid) => fsWatcher.stop(wid))
    return id
  })
  ipcMain.on(IPC.fsUnwatch, (e, id: string) => {
    fsWatcher.stop(id)
    fsWatchesBySender.get(e.sender.id)?.delete(id)
  })

  // Remote filesystem over SFTP (channel on the existing client)
  ipcMain.handle(IPC.sftpList, async (_e, sid: string, path?: string) =>
    listRemote(await ssh.getSftp(sid), path)
  )
  ipcMain.handle(IPC.sftpHome, async (_e, sid: string) => sftpHome(await ssh.getSftp(sid)))
  ipcMain.handle(IPC.sftpMkdir, async (_e, sid: string, p: string) =>
    mkdirRemote(await ssh.getSftp(sid), p)
  )
  ipcMain.handle(IPC.sftpCreateFile, async (_e, sid: string, p: string) =>
    createFileRemote(await ssh.getSftp(sid), p)
  )
  ipcMain.handle(IPC.sftpRename, async (_e, sid: string, from: string, to: string) =>
    renameRemote(await ssh.getSftp(sid), from, to)
  )
  ipcMain.handle(IPC.sftpDelete, async (_e, sid: string, p: string) =>
    deleteRemote(await ssh.getSftp(sid), p)
  )
  ipcMain.handle(IPC.sftpReadFile, async (_e, sid: string, p: string) =>
    readFileRemote(await ssh.getSftp(sid), p)
  )
  ipcMain.handle(IPC.sftpWriteFile, async (_e, sid: string, p: string, content: string) =>
    writeFileRemote(await ssh.getSftp(sid), p, content)
  )

  // Live remote directory watching (SFTP polling) — mirror of the local watcher.
  const sftpWatcher = new SftpWatchManager(
    (sid) => ssh.getSftp(sid),
    (id, listing) => send(`${IPC.sftpWatchEvent}:${id}`, listing)
  )
  const sftpWatchesBySender = new Map<number, Set<string>>()
  ipcMain.handle(IPC.sftpWatch, async (e, sid: string, p: string) => {
    const id = await sftpWatcher.start(sid, p)
    trackWatch(e.sender, sftpWatchesBySender, id, (wid) => sftpWatcher.stop(wid))
    return id
  })
  ipcMain.on(IPC.sftpUnwatch, (e, id: string) => {
    sftpWatcher.stop(id)
    sftpWatchesBySender.get(e.sender.id)?.delete(id)
  })

  return {
    stopWatches: () => {
      fsWatcher.stopAll()
      sftpWatcher.stopAll()
      fsWatchesBySender.clear()
      sftpWatchesBySender.clear()
    }
  }
}

/**
 * Key a watch id by the requesting webContents so a renderer reload (which
 * never sends unwatch) can't leak fs.watch handles / SFTP poll timers until
 * app quit: when the sender is destroyed, every watch it started is stopped.
 */
function trackWatch(
  sender: Electron.WebContents,
  registry: Map<number, Set<string>>,
  id: string,
  stop: (id: string) => void
): void {
  if (sender.isDestroyed()) {
    stop(id)
    return
  }
  let set = registry.get(sender.id)
  if (!set) {
    set = new Set()
    registry.set(sender.id, set)
    sender.once('destroyed', () => {
      const ids = registry.get(sender.id)
      registry.delete(sender.id)
      if (ids) for (const wid of ids) stop(wid)
    })
  }
  set.add(id)
}
