import { watch as fsWatch, type FSWatcher } from 'fs'
import { randomUUID } from 'crypto'
import type { DirListing } from '@shared/types'
import { listLocal } from './local'

// Debounce bursts of fs.watch events (editors write+rename+chmod in quick
// succession) into a single re-list.
const DEBOUNCE_MS = 150
// fs.watch is best-effort: it can miss events on Windows, network shares, and
// some FUSE mounts. A slow safety poll guarantees the listing still converges
// even when the OS never fires an event.
const SAFETY_POLL_MS = 4000

/**
 * A content signature for a directory listing — name/type/size/mtime of each
 * entry. Two listings with the same signature are indistinguishable to the UI,
 * so we only push an event (and trigger a re-render) when this changes. Listings
 * are already sorted by the list functions, so order is stable.
 */
export function dirSignature(l: DirListing): string {
  return l.entries
    .map((e) => `${e.name}\t${e.isDir ? 'd' : e.isSymlink ? 'l' : 'f'}\t${e.size}\t${e.mtimeMs}`)
    .join('\n')
}

interface LocalWatch {
  watcher?: FSWatcher
  debounce?: NodeJS.Timeout
  poll: NodeJS.Timeout
  lastSig: string
}

/**
 * Watches local directories and pushes a fresh listing whenever the directory's
 * contents change. Each watch is event-driven (fs.watch) with a low-frequency
 * safety poll as a backstop, and emits only on a real content change (diffed via
 * dirSignature) so the renderer never re-renders for nothing.
 */
export class FsWatchManager {
  private watches = new Map<string, LocalWatch>()

  constructor(private emit: (watchId: string, listing: DirListing) => void) {}

  async start(path: string): Promise<string> {
    const id = randomUUID()
    // Baseline from the current contents so the renderer (which already has this
    // listing from its own list() call) isn't told about a change that isn't one.
    let lastSig = ''
    try {
      lastSig = dirSignature(await listLocal(path))
    } catch {
      /* unreadable now; the first successful re-list will establish it */
    }
    const w: LocalWatch = { lastSig, poll: undefined as unknown as NodeJS.Timeout }

    const relist = async () => {
      try {
        const listing = await listLocal(path)
        const sig = dirSignature(listing)
        if (sig !== w.lastSig) {
          w.lastSig = sig
          this.emit(id, listing)
        }
      } catch {
        /* dir vanished/unreadable — the parent dir's watch reflects the removal */
      }
    }
    const schedule = () => {
      if (w.debounce) clearTimeout(w.debounce)
      w.debounce = setTimeout(relist, DEBOUNCE_MS)
    }

    try {
      w.watcher = fsWatch(path, { persistent: false }, () => schedule())
      // A watch error (dir deleted, handle limit) just leaves the poll in charge.
      w.watcher.on('error', () => {})
    } catch {
      /* platform/path doesn't support fs.watch — the poll covers it */
    }
    w.poll = setInterval(relist, SAFETY_POLL_MS)
    this.watches.set(id, w)
    return id
  }

  stop(id: string): void {
    const w = this.watches.get(id)
    if (!w) return
    if (w.debounce) clearTimeout(w.debounce)
    clearInterval(w.poll)
    try {
      w.watcher?.close()
    } catch {
      /* ignore */
    }
    this.watches.delete(id)
  }

  stopAll(): void {
    for (const id of [...this.watches.keys()]) this.stop(id)
  }
}
