import { createReadStream, createWriteStream, promises as fs } from 'fs'
import type { Readable, Writable } from 'stream'
import type { SFTPWrapper } from 'ssh2'
import { statRemote } from '../ssh/sftp'
import type { TransferEvent, TransferItemV2 } from '@shared/types'
import type { TransferStore } from './store'

/**
 * Resolver for the session's SFTP channel. We never open a new ssh2 client
 * here — the SSHManager owns the client and channels; we ask for an SFTP
 * wrapper and use it for both uploads and downloads.
 */
export type SftpResolver = (sessionId: string) => Promise<SFTPWrapper>

/**
 * The streaming payload the queue asks the underlying transfer engine to run.
 * Mirrors the legacy `TransferStartOpts` shape; consumed by the same code
 * path that `TransferManager` in `../transfer.ts` uses (so the existing
 * SFTP read/write stream dance is reused without forking the network stack).
 */
export interface QueueItem {
  id: string
  sessionId: string
  direction: 'upload' | 'download'
  localPath: string
  remotePath: string
}

export interface QueueListeners {
  onItemEvent(item: TransferItemV2, ev: TransferEvent): void
  onListChanged(): void
}

const CONCURRENCY = 2
/**
 * The existing TransferManager throttles at 80ms (a bit aggressive for our
 * 250ms target). The queue emits its own tick at this interval to keep the
 * renderer updates well-paced and the disk writes coalesced.
 */
const PROGRESS_THROTTLE_MS = 250

/**
 * Producer/consumer queue. Concurrency is hard-capped at 2. Items flow from
 * the store (in-memory) to the active set; progress events are throttled to
 * 250ms and forwarded to the renderer; done events are persisted.
 */
export class TransferQueue {
  private store: TransferStore
  private getSftp: SftpResolver
  private listeners: Set<QueueListeners> = new Set()
  /** Items still in the "pending" pool, FIFO. */
  private pending: string[] = []
  /** Items currently being streamed. */
  private active: Set<string> = new Set()
  private lastProgressEmit = new Map<string, number>()
  private alive = true

  constructor(store: TransferStore, getSftp: SftpResolver) {
    this.store = store
    this.getSftp = getSftp
  }

  /** Stop accepting new work; abort in-flight streams so settle paths finish. */
  shutdown(): void {
    this.alive = false
    this.pending = []
    for (const cancel of this.cancelers.values()) {
      try {
        cancel()
      } catch {
        /* ignore */
      }
    }
    this.active.clear()
  }

  /** Subscribe to per-item events + list ticks. Returns an unsubscribe. */
  subscribe(l: QueueListeners): () => void {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }

  /** Push a new item to the back of the queue and start the pump if room. */
  enqueue(opts: Omit<QueueItem, 'id'> & { id?: string }): TransferItemV2 {
    const id = opts.id ?? randomId()
    const item: TransferItemV2 = {
      id,
      direction: opts.direction,
      sessionId: opts.sessionId,
      localPath: opts.localPath,
      remotePath: opts.remotePath,
      total: 0,
      transferred: 0,
      done: false,
      enqueuedAt: Date.now()
    }
    // We mutate the store via the synchronous helper to avoid a round trip
    // back to the renderer — but we still need the store's persistence to
    // fire. Use the public `add` which flushes.
    void this.store.add(item)
    this.pending.push(id)
    this.notifyList()
    this.pump()
    return this.store.get(id) ?? item
  }

  /** Mark an item as canceled. If it's in flight, abort the streams and let
   *  runOne's settle path own the store patch + done event (avoids double-finish
   *  and losing the 'canceled' reason when the destroy path races). */
  async cancel(id: string): Promise<void> {
    const it = this.store.get(id)
    if (!it) return
    if (it.done || it.canceled) return
    if (this.active.has(id)) {
      this.cancelers.get(id)?.()
      return
    }
    // Not yet running — just drop it from the pending pool and mark done.
    this.pending = this.pending.filter((x) => x !== id)
    await this.store.patch(id, {
      done: true,
      canceled: true,
      error: 'canceled',
      finishedAt: Date.now()
    })
    this.emitEvent(id, {
      kind: 'done',
      id,
      transferred: 0,
      total: 0,
      canceled: true,
      error: 'canceled',
      finishedAt: Date.now()
    })
    this.notifyList()
    this.pump()
  }

  /**
   * Re-enqueue a previously finished item. The new id is what's returned;
   * the old id stays in the store (so the user can see what happened).
   */
  async retry(oldId: string): Promise<TransferItemV2 | null> {
    const fresh = await this.store.retry(oldId)
    if (!fresh) return null
    this.pending.push(fresh.id)
    this.notifyList()
    this.pump()
    return fresh
  }

  /**
   * Hydrate the queue's pending list from the store at startup. Items left
   * in flight at the time of the last crash are already marked canceled by
   * the store's loader, so we only enqueue the fresh ones.
   */
  rehydrateFromStore(): void {
    const items = this.store.list()
    for (const it of items) {
      if (!it.done && !it.canceled) this.pending.push(it.id)
    }
    this.notifyList()
    this.pump()
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  private notifyList(): void {
    const list = this.store.list()
    for (const l of this.listeners) l.onListChanged()
    // The store IS the source of truth; renderer asks for the snapshot when
    // `onStatus` fires, so we don't re-emit the list here.
    void list
  }

  private emitEvent(id: string, ev: TransferEvent): void {
    const it = this.store.get(id)
    if (!it) return
    for (const l of this.listeners) l.onItemEvent(it, ev)
  }

  private cancelers = new Map<string, () => void>()

  private pump(): void {
    if (!this.alive) return
    while (this.active.size < CONCURRENCY && this.pending.length > 0) {
      const id = this.pending.shift()!
      const item = this.store.get(id)
      if (!item) continue
      if (item.done || item.canceled) continue
      this.active.add(id)
      this.cancelers.set(id, () => { /* placeholder */ })
      void this.runOne(item).catch((err) => {
        // The run path catches its own errors; this is the safety net for
        // a synchronous throw before the first await.
        console.warn('transfers queue: unexpected error in runOne:', err)
      })
    }
  }

  private async runOne(item: TransferItemV2): Promise<void> {
    const id = item.id
    const isDownload = item.direction === 'download'
    let total = 0
    let sftp: SFTPWrapper | null = null
    try {
      sftp = await this.getSftp(item.sessionId)
      total = isDownload
        ? ((await statRemote(sftp, item.remotePath)).size ?? 0)
        : (await fs.stat(item.localPath)).size
    } catch (err) {
      await this.finishItem(id, 0, total, false, String((err as Error)?.message || err))
      return
    }
    await this.store.patch(id, { total })
    this.emitProgress(id, 0, total, false)

    const read: Readable = isDownload
      ? sftp.createReadStream(item.remotePath)
      : createReadStream(item.localPath)
    const write: Writable = isDownload
      ? createWriteStream(item.localPath)
      : sftp.createWriteStream(item.remotePath)

    let transferred = 0
    let canceled = false
    this.cancelers.set(id, () => {
      canceled = true
      read.destroy()
      write.destroy()
    })

    read.on('data', (chunk: Buffer) => {
      transferred += chunk.length
      this.emitProgress(id, transferred, total, false)
    })

    try {
      await new Promise<void>((resolve, reject) => {
        write.on('close', () => resolve())
        write.on('error', reject)
        read.on('error', reject)
        read.pipe(write)
      })
      this.cancelers.delete(id)
      this.active.delete(id)
      await this.finishItem(id, transferred, total, canceled, undefined)
    } catch (err) {
      this.cancelers.delete(id)
      this.active.delete(id)
      await this.finishItem(
        id,
        transferred,
        total,
        canceled,
        canceled ? undefined : String((err as Error)?.message || err)
      )
    } finally {
      this.pump()
    }
  }

  private emitProgress(id: string, transferred: number, total: number, done: boolean): void {
    // Throttle to PROGRESS_THROTTLE_MS per id, but always let the final tick through.
    const now = Date.now()
    const last = this.lastProgressEmit.get(id) ?? 0
    if (!done && now - last < PROGRESS_THROTTLE_MS) {
      // Persist progress on every chunk (store batches writes) but only
      // forward to the renderer at the throttled cadence.
      void this.store.patch(id, { transferred, total })
      return
    }
    this.lastProgressEmit.set(id, now)
    void this.store.patch(id, { transferred, total })
    this.emitEvent(id, { kind: 'progress', id, transferred, total, done })
  }

  private async finishItem(
    id: string,
    transferred: number,
    total: number,
    canceled: boolean,
    error: string | undefined
  ): Promise<void> {
    const finishedAt = Date.now()
    await this.store.patch(id, {
      transferred,
      total,
      done: true,
      canceled: canceled || undefined,
      error,
      finishedAt
    })
    this.emitEvent(id, {
      kind: 'done',
      id,
      transferred,
      total,
      canceled: canceled || undefined,
      error,
      finishedAt
    })
    this.lastProgressEmit.delete(id)
    this.notifyList()
  }
}

function randomId(): string {
  const t = Date.now().toString(36)
  const r = Math.random().toString(36).slice(2, 10)
  return `t-${t}-${r}`
}
