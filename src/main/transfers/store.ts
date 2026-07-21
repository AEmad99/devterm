import { promises as fs } from 'fs'
import { join } from 'path'
import type { TransferItemV2 } from '@shared/types'

/**
 * On-disk + in-memory list of `TransferItemV2` rows. Persisted to
 * `userData/transfers.json` (atomic write: tmp + rename). On launch, any item
 * that is still in flight (not done, not canceled) is marked canceled with
 * reason "interrupted by restart" — bytes are never resumed mid-flight.
 *
 * The store is the single source of truth for the renderer; the queue in
 * `queue.ts` consults it on startup and pushes status changes back through it.
 */
/** Cap finished rows so transfers.json can't grow without bound for heavy users. */
const MAX_FINISHED = 200

export class TransferStore {
  private items: TransferItemV2[] = []
  private file: string
  private writeTimer: NodeJS.Timeout | null = null
  private dirty = false
  /** Serialize disk writes so overlapping flushNow calls can't race the .tmp path. */
  private writeChain: Promise<void> = Promise.resolve()

  constructor(userData: string) {
    this.file = join(userData, 'transfers.json')
  }

  private pruneFinished(): void {
    let finished = 0
    for (const it of this.items) if (it.done) finished++
    if (finished <= MAX_FINISHED) return
    let drop = finished - MAX_FINISHED
    // Drop oldest finished rows first (list is newest-first).
    for (let i = this.items.length - 1; i >= 0 && drop > 0; i--) {
      if (this.items[i].done) {
        this.items.splice(i, 1)
        drop--
      }
    }
  }

  /** Load from disk; mark in-flight items as canceled (interrupted by restart). */
  async load(): Promise<TransferItemV2[]> {
    try {
      const raw = await fs.readFile(this.file, 'utf-8')
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        this.items = parsed.filter(isTransferItemV2)
      }
    } catch (e) {
      const err = e as NodeJS.ErrnoException
      if (err.code !== 'ENOENT') {
        console.warn('transfers.json: failed to read, starting empty:', err.message)
      }
      this.items = []
    }
    // Anything still running when the app last died is unrecoverable — the
    // ssh2 channel and streams are gone with the process. Mark + persist.
    let mutated = false
    const now = Date.now()
    for (const it of this.items) {
      if (!it.done && !it.canceled) {
        it.done = true
        it.canceled = true
        it.error = 'interrupted by restart'
        it.finishedAt = now
        mutated = true
      }
    }
    if (mutated) await this.flushNow()
    return this.list()
  }

  list(): TransferItemV2[] {
    // Return a stable copy so renderers can't mutate our internal state.
    return this.items.map((it) => ({ ...it }))
  }

  get(id: string): TransferItemV2 | undefined {
    const it = this.items.find((x) => x.id === id)
    return it ? { ...it } : undefined
  }

  /** Add a new item, persist, return the stored copy. */
  async add(item: TransferItemV2): Promise<TransferItemV2> {
    this.items.unshift(item)
    this.pruneFinished()
    await this.flushNow()
    return { ...item }
  }

  /**
   * Patch an item in place. Returns the updated copy, or null when the id
   * is unknown. The patch is shallow-merged; falsy values are kept as-is
   * (use `null`/`undefined` to clear an optional field).
   */
  async patch(id: string, patch: Partial<TransferItemV2>): Promise<TransferItemV2 | null> {
    const idx = this.items.findIndex((x) => x.id === id)
    if (idx < 0) return null
    const next: TransferItemV2 = { ...this.items[idx], ...patch }
    this.items[idx] = next
    this.scheduleFlush()
    return { ...next }
  }

  /**
   * Drop the items that are done. Returns the surviving list. Active items
   * are untouched. An item is considered finished when it is done and not
   * actively running — that covers success, cancellation, error, and the
   * post-restart 'interrupted' rows that `load()` synthesizes.
   */
  async clearFinished(): Promise<TransferItemV2[]> {
    this.items = this.items.filter((x) => !x.done)
    await this.flushNow()
    return this.list()
  }

  /**
   * Replace an old id with a fresh one (used by `retry`). The new item
   * starts with `done:false, transferred:0, enqueuedAt:now`. Returns null
   * when the old id is unknown or already active.
   */
  async retry(oldId: string): Promise<TransferItemV2 | null> {
    const idx = this.items.findIndex((x) => x.id === oldId)
    if (idx < 0) return null
    const old = this.items[idx]
    if (!old.done && !old.canceled) return null
    const fresh: TransferItemV2 = {
      id: randomId(),
      direction: old.direction,
      sessionId: old.sessionId,
      localPath: old.localPath,
      remotePath: old.remotePath,
      total: 0,
      transferred: 0,
      done: false,
      enqueuedAt: Date.now()
    }
    this.items.unshift(fresh)
    await this.flushNow()
    return { ...fresh }
  }

  /** Force any pending write to disk. Called on quit / list / add. */
  async flushNow(): Promise<void> {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer)
      this.writeTimer = null
    }
    this.dirty = false
    const snapshot = JSON.stringify(this.items, null, 2)
    const file = this.file
    this.writeChain = this.writeChain
      .catch(() => {
        /* keep chain alive after a prior failure */
      })
      .then(async () => {
        const tmp = file + '.tmp'
        try {
          await fs.mkdir(join(file, '..'), { recursive: true })
          await fs.writeFile(tmp, snapshot, 'utf-8')
          await fs.rename(tmp, file)
        } catch (e) {
          console.warn('transfers.json: failed to persist:', (e as Error).message)
        }
      })
    await this.writeChain
  }

  /** Coalesce frequent patches (progress) into a single flush. */
  private scheduleFlush(): void {
    this.dirty = true
    if (this.writeTimer) return
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null
      if (this.dirty) void this.flushNow()
    }, 250)
  }
}

function isTransferItemV2(x: unknown): x is TransferItemV2 {
  if (!x || typeof x !== 'object') return false
  const it = x as Record<string, unknown>
  return (
    typeof it.id === 'string' &&
    (it.direction === 'upload' || it.direction === 'download') &&
    typeof it.sessionId === 'string' &&
    typeof it.localPath === 'string' &&
    typeof it.remotePath === 'string' &&
    typeof it.total === 'number' &&
    typeof it.transferred === 'number' &&
    typeof it.done === 'boolean' &&
    typeof it.enqueuedAt === 'number'
  )
}

function randomId(): string {
  // Short, sortable, unique enough for the queue. Same shape the existing
  // TransferManager uses for live transfer ids; helps with debugging.
  const t = Date.now().toString(36)
  const r = Math.random().toString(36).slice(2, 10)
  return `t-${t}-${r}`
}
