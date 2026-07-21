import { randomUUID } from 'crypto'
import { posix } from 'path'
import type { SFTPWrapper } from 'ssh2'
import type { DirListing } from '@shared/types'
import { listRemote } from './sftp'
import { dirSignature } from '../fs/watch'

// SFTP has no inotify-style change notifications, so we poll. 2.5s is a good
// balance between feeling live and not hammering the channel on big trees.
const POLL_MS = 2500

/**
 * Consecutive failed polls tolerated before the stale listing is cleared.
 * Failures during an SSH reconnect are transient (SFTP channel down for a
 * few seconds), so the watch must NOT stop on the first error — it keeps
 * polling and recovers on its own once the session is back. After
 * `MAX_CONSECUTIVE_ERRORS` the path is presumed gone: we emit one empty
 * listing so the UI clears, but keep polling in case the path (or session)
 * returns.
 */
const MAX_CONSECUTIVE_ERRORS = 5

interface RemoteWatch {
  poll: NodeJS.Timeout
  lastSig: string
  errors: number
  cleared: boolean
}

function emptyRemoteListing(path: string): DirListing {
  const p = posix.normalize(path)
  return { path: p, parent: p === '/' ? null : posix.dirname(p), entries: [] }
}

/**
 * Watches remote directories over SFTP by polling readdir on the session's
 * existing channel and pushing a fresh listing only when the content signature
 * changes. Transient failures (reconnects) are tolerated; a watched path that
 * stays missing clears the stale listing once. Polling uses a self-rescheduling
 * setTimeout chain so a slow SFTP round-trip can never overlap the next tick.
 */
export class SftpWatchManager {
  private watches = new Map<string, RemoteWatch>()

  constructor(
    private getSftp: (sessionId: string) => Promise<SFTPWrapper>,
    private emit: (watchId: string, listing: DirListing) => void
  ) {}

  async start(sessionId: string, path: string): Promise<string> {
    const id = randomUUID()
    let lastSig = ''
    try {
      lastSig = dirSignature(await listRemote(await this.getSftp(sessionId), path))
    } catch {
      /* session may still be settling; first good poll establishes it */
    }
    const w: RemoteWatch = {
      lastSig,
      poll: undefined as unknown as NodeJS.Timeout,
      errors: 0,
      cleared: false
    }

    const tick = async () => {
      if (!this.watches.has(id)) return
      try {
        const listing = await listRemote(await this.getSftp(sessionId), path)
        const sig = dirSignature(listing)
        w.errors = 0
        w.cleared = false
        if (sig !== w.lastSig) {
          w.lastSig = sig
          this.emit(id, listing)
        }
      } catch {
        w.errors += 1
        if (w.errors >= MAX_CONSECUTIVE_ERRORS && !w.cleared) {
          w.cleared = true
          w.lastSig = ''
          this.emit(id, emptyRemoteListing(path))
        }
      }
      // Self-rescheduling chain: the next poll is armed only after this one
      // settled, so ticks never overlap on a slow channel.
      if (this.watches.has(id)) w.poll = setTimeout(tick, POLL_MS)
    }
    w.poll = setTimeout(tick, POLL_MS)
    this.watches.set(id, w)
    return id
  }

  stop(id: string): void {
    const w = this.watches.get(id)
    if (!w) return
    clearTimeout(w.poll)
    this.watches.delete(id)
  }

  stopAll(): void {
    for (const id of [...this.watches.keys()]) this.stop(id)
  }
}
