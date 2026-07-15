import { app, ipcMain, BrowserWindow } from 'electron'
import { IPC, type TransferItemV2, type TransferListResult } from '@shared/types'
import type { SSHManager } from '../ssh/manager'
import { TransferStore } from '../transfers/store'
import { TransferQueue, type QueueItem } from '../transfers/queue'

/**
 * Register the persistent transfer queue IPC. The store is the on-disk +
 * in-memory list; the queue is the producer/consumer that actually streams
 * bytes through the SFTP channel that the SSHManager already owns. We never
 * open a new ssh2 client here — `getSftp` is the same channel the file
 * browser uses.
 *
 * Renderer-facing channels:
 *  - transfers:list / enqueueUpload / enqueueDownload / cancel / retry / clearFinished
 *  - transfers:event:<id>     — live progress for one item
 *  - transfers:status         — broadcast on every list change
 */
export function registerTransfersIpc(
  ssh: SSHManager,
  getWindow: () => BrowserWindow | null
): {
  /** On quit: cancel in-flight work + persist pending items as canceled. */
  shutdown: () => Promise<void>
} {
  const send = (channel: string, ...args: unknown[]) => {
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
  }

  const userData = app.getPath('userData')

  const store = new TransferStore(userData)
  const queue = new TransferQueue(store, (sid) => ssh.getSftp(sid))

  // Persist the loaded snapshot before we re-hydrate the pending pool so
  // anything in-flight at the time of the last crash is durably marked
  // canceled with reason "interrupted by restart".
  void store.load().then(() => {
    queue.rehydrateFromStore()
    // Tell every renderer the post-load snapshot, in case any window was
    // already listening (the IPC channel name is shared across windows).
    send(IPC.transfersStatus)
  })

  // Fan out queue events to every renderer. The per-item event uses an id
  // suffix (mirrors the per-session pty/agent pattern); the global tick
  // is a single channel that everyone re-subscribes to.
  queue.subscribe({
    onItemEvent: (item, ev) => {
      send(`${IPC.transfersEvent}:${item.id}`, ev)
      if (ev.kind === 'done') {
        send(IPC.transfersStatus)
      }
    },
    onListChanged: () => send(IPC.transfersStatus)
  })

  ipcMain.handle(IPC.transfersList, (): TransferListResult => store.list())
  ipcMain.handle(IPC.transfersEnqueueUpload, (_e, opts: Omit<QueueItem, 'id' | 'direction'>) => {
    if (!ssh.getContext(opts.sessionId)) {
      throw new Error(`transfers: unknown sessionId ${opts.sessionId}`)
    }
    return queue.enqueue({ ...opts, direction: 'upload' })
  })
  ipcMain.handle(IPC.transfersEnqueueDownload, (_e, opts: Omit<QueueItem, 'id' | 'direction'>) => {
    if (!ssh.getContext(opts.sessionId)) {
      throw new Error(`transfers: unknown sessionId ${opts.sessionId}`)
    }
    return queue.enqueue({ ...opts, direction: 'download' })
  })
  ipcMain.handle(IPC.transfersCancel, async (_e, id: string) => {
    await queue.cancel(id)
  })
  ipcMain.handle(IPC.transfersRetry, async (_e, id: string): Promise<TransferItemV2 | null> => {
    return queue.retry(id)
  })
  ipcMain.handle(IPC.transfersClearFinished, async (): Promise<TransferListResult> => {
    const result = await store.clearFinished()
    send(IPC.transfersStatus)
    return result
  })

  return {
    shutdown: async () => {
      queue.shutdown()
      await store.flushNow()
    }
  }
}
