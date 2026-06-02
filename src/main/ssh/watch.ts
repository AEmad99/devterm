import { randomUUID } from 'crypto'
import type { SFTPWrapper } from 'ssh2'
import type { DirListing } from '@shared/types'
import { listRemote } from './sftp'
import { dirSignature } from '../fs/watch'

// SFTP has no inotify-style change notifications, so we poll. 2.5s is a good
// balance between feeling live and not hammering the channel on big trees.
const POLL_MS = 2500

interface RemoteWatch {
  poll: NodeJS.Timeout
  lastSig: string
}

/**
 * Watches remote directories over SFTP by polling readdir on the session's
 * existing channel and pushing a fresh listing only when the content signature
 * changes. If the session's SFTP channel is gone (disconnected), the watch stops
 * itself rather than polling a dead session forever.
 */
export class SftpWatchManager {
  private watches = new Map<string, RemoteWatch>()

  constructor(
    private getSftp: (sessionId: string) => Promise<SFTPWrapper>,
    private emit: (watchId: string, listing: DirListing) => void
  ) {}

  async start(sessionId: string, path: string): Promise<string> {
    const id = randomUUID()
    // Baseline so we don't re-announce the listing the renderer already has.
    let lastSig = ''
    try {
      lastSig = dirSignature(await listRemote(await this.getSftp(sessionId), path))
    } catch {
      /* session may still be settling; first good poll establishes it */
    }
    const w: RemoteWatch = { lastSig, poll: undefined as unknown as NodeJS.Timeout }

    const tick = async () => {
      try {
        const listing = await listRemote(await this.getSftp(sessionId), path)
        const sig = dirSignature(listing)
        if (sig !== w.lastSig) {
          w.lastSig = sig
          this.emit(id, listing)
        }
      } catch (e) {
        // The session is gone for good — stop polling. Transient SFTP errors
        // (a brief readdir failure) are retried on the next tick.
        if (String((e as Error).message || e).includes('unknown session')) this.stop(id)
      }
    }
    w.poll = setInterval(tick, POLL_MS)
    this.watches.set(id, w)
    return id
  }

  stop(id: string): void {
    const w = this.watches.get(id)
    if (!w) return
    clearInterval(w.poll)
    this.watches.delete(id)
  }

  stopAll(): void {
    for (const id of [...this.watches.keys()]) this.stop(id)
  }
}
