import { randomUUID } from 'crypto'
import { posix } from 'path'
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

function emptyRemoteListing(path: string): DirListing {
  const p = posix.normalize(path)
  return { path: p, parent: p === '/' ? null : posix.dirname(p), entries: [] }
}

/**
 * Watches remote directories over SFTP by polling readdir on the session's
 * existing channel and pushing a fresh listing only when the content signature
 * changes. If a watched path disappears or the session ends, the watch clears
 * the stale listing once and then stops itself.
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
    const w: RemoteWatch = { lastSig, poll: undefined as unknown as NodeJS.Timeout }

    const tick = async () => {
      try {
        const listing = await listRemote(await this.getSftp(sessionId), path)
        const sig = dirSignature(listing)
        if (sig !== w.lastSig) {
          w.lastSig = sig
          this.emit(id, listing)
        }
      } catch {
        this.emit(id, emptyRemoteListing(path))
        this.stop(id)
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
