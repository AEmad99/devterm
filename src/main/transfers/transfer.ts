import { randomUUID } from 'crypto'
import { createReadStream, createWriteStream, promises as fs } from 'fs'
import type { Readable, Writable } from 'stream'
import type { SFTPWrapper } from 'ssh2'
import type { TransferProgress, TransferStartOpts } from '@shared/types'
import { statRemote } from '../ssh/sftp'

export interface TransferDeps {
  getSftp: (sessionId: string) => Promise<SFTPWrapper>
  onProgress: (id: string, p: TransferProgress) => void
}

/**
 * Streamed upload/download (no full buffering). Progress is throttled; cancel
 * truly aborts by destroying the streams mid-flight (Phase 4 acceptance).
 */
export class TransferManager {
  private cancels = new Map<string, () => void>()

  constructor(private deps: TransferDeps) {}

  start(opts: TransferStartOpts): string {
    const id = randomUUID()
    void this.run(id, opts).catch((err) =>
      this.deps.onProgress(id, {
        id,
        transferred: 0,
        total: 0,
        done: true,
        error: String((err as Error)?.message || err)
      })
    )
    return id
  }

  cancel(id: string): void {
    this.cancels.get(id)?.()
  }

  cancelAll(): void {
    for (const c of this.cancels.values()) c()
  }

  private async run(id: string, opts: TransferStartOpts): Promise<void> {
    const sftp = await this.deps.getSftp(opts.sessionId)
    const download = opts.direction === 'download'
    const total = download
      ? ((await statRemote(sftp, opts.remotePath)).size ?? 0)
      : (await fs.stat(opts.localPath)).size

    const read: Readable = download
      ? sftp.createReadStream(opts.remotePath)
      : createReadStream(opts.localPath)
    const write: Writable = download
      ? createWriteStream(opts.localPath)
      : sftp.createWriteStream(opts.remotePath)

    let transferred = 0
    let canceled = false
    let lastEmit = 0
    const emit = (done: boolean) => {
      const now = Date.now()
      if (!done && now - lastEmit < 80) return
      lastEmit = now
      this.deps.onProgress(id, { id, transferred, total, done })
    }

    this.cancels.set(id, () => {
      canceled = true
      read.destroy()
      write.destroy()
    })

    read.on('data', (chunk: Buffer) => {
      transferred += chunk.length
      emit(false)
    })

    try {
      await new Promise<void>((resolve, reject) => {
        write.on('close', () => resolve())
        write.on('error', reject)
        read.on('error', reject)
        read.pipe(write)
      })
      this.cancels.delete(id)
      this.deps.onProgress(id, { id, transferred, total, done: true, canceled })
    } catch (err) {
      this.cancels.delete(id)
      this.deps.onProgress(id, {
        id,
        transferred,
        total,
        done: true,
        canceled,
        error: canceled ? undefined : String((err as Error)?.message || err)
      })
    }
  }
}
