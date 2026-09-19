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
  sessionId: string
  path: string
  poll?: NodeJS.Timeout
  lastSig: string
  errors: number
  cleared: boolean
  paused: boolean
  inFlight: boolean
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
    private emit: (watchId: string, listing: DirListing) => void,
    private pollMs = POLL_MS
  ) {}

  async start(sessionId: string, path: string): Promise<string> {
    const id = randomUUID()
    const w: RemoteWatch = {
      sessionId,
      path,
      lastSig: '',
      errors: 0,
      cleared: false,
      paused: false,
      inFlight: false
    }
    // Register before the initial listing so a pause arriving while that
    // listing is in flight can prevent the first timer from being armed.
    this.watches.set(id, w)
    let lastSig = ''
    try {
      lastSig = dirSignature(await listRemote(await this.getSftp(sessionId), path))
    } catch {
      /* session may still be settling; first good poll establishes it */
    }
    w.lastSig = lastSig
    this.schedule(id, w)
    return id
  }

  /** Pause without tearing down the watch; resume performs one immediate poll. */
  setPaused(id: string, paused: boolean): void {
    const w = this.watches.get(id)
    if (!w || w.paused === paused) return
    w.paused = paused
    if (paused) {
      if (w.poll) clearTimeout(w.poll)
      w.poll = undefined
      return
    }
    if (!w.inFlight) void this.tick(id, w)
  }

  private schedule(id: string, w: RemoteWatch): void {
    if (!this.watches.has(id) || w.paused || w.poll || w.inFlight) return
    w.poll = setTimeout(() => {
      w.poll = undefined
      void this.tick(id, w)
    }, this.pollMs)
  }

  private async tick(id: string, w: RemoteWatch): Promise<void> {
    if (!this.watches.has(id) || w.paused || w.inFlight) return
    w.inFlight = true
    try {
      try {
        const listing = await listRemote(await this.getSftp(w.sessionId), w.path)
        const sig = dirSignature(listing)
        w.errors = 0
        w.cleared = false
        if (sig !== w.lastSig && this.watches.has(id)) {
          w.lastSig = sig
          this.emit(id, listing)
        }
      } catch {
        w.errors += 1
        if (w.errors >= MAX_CONSECUTIVE_ERRORS && !w.cleared && this.watches.has(id)) {
          w.cleared = true
          w.lastSig = ''
          this.emit(id, emptyRemoteListing(w.path))
        }
      }
    } finally {
      w.inFlight = false
      // Self-rescheduling chain: the next poll is armed only after this one
      // settled, so ticks never overlap on a slow channel. A pause that lands
      // while SFTP is in flight therefore allows this request to finish but
      // prevents all subsequent poll traffic.
      this.schedule(id, w)
    }
  }

  stop(id: string): void {
    const w = this.watches.get(id)
    if (!w) return
    if (w.poll) clearTimeout(w.poll)
    this.watches.delete(id)
  }

  stopAll(): void {
    for (const id of [...this.watches.keys()]) this.stop(id)
  }
}
