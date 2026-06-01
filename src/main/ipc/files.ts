import { ipcMain, BrowserWindow } from 'electron'
import { IPC, type TransferStartOpts } from '@shared/types'
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
import { TransferManager } from '../transfer'
import type { SSHManager } from '../ssh/manager'

export function registerFileIpc(
  ssh: SSHManager,
  getWindow: () => BrowserWindow | null
): TransferManager {
  // Local filesystem
  ipcMain.handle(IPC.fsList, (_e, path?: string) => listLocal(path))
  ipcMain.handle(IPC.fsHome, () => localHome())
  ipcMain.handle(IPC.fsMkdir, (_e, p: string) => mkdirLocal(p))
  ipcMain.handle(IPC.fsCreateFile, (_e, p: string) => createFileLocal(p))
  ipcMain.handle(IPC.fsRename, (_e, from: string, to: string) => renameLocal(from, to))
  ipcMain.handle(IPC.fsDelete, (_e, p: string) => deleteLocal(p))
  ipcMain.handle(IPC.fsReadFile, (_e, p: string) => readFileLocal(p))
  ipcMain.handle(IPC.fsWriteFile, (_e, p: string, content: string) => writeFileLocal(p, content))

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

  // Transfers
  const send = (channel: string, ...args: unknown[]) => {
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
  }
  const transfers = new TransferManager({
    getSftp: (sid) => ssh.getSftp(sid),
    onProgress: (id, p) => send(`${IPC.transferProgress}:${id}`, p)
  })
  ipcMain.handle(IPC.transferStart, (_e, opts: TransferStartOpts) => transfers.start(opts))
  ipcMain.on(IPC.transferCancel, (_e, id: string) => transfers.cancel(id))

  return transfers
}
