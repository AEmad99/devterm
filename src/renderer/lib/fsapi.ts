import type { DirListing } from '@shared/types'

/**
 * The filesystem operations a file pane / tree needs, abstracting local fs vs
 * remote SFTP. Both `FilePane` and `FileTree` are driven by an `FsApi`, so the
 * same UI serves local and remote sessions.
 */
export interface FsApi {
  list(path?: string): Promise<DirListing>
  home(): Promise<string>
  mkdir(path: string): Promise<void>
  /** Create an empty file; rejects if something already exists at `path`. */
  createFile(path: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  delete(path: string): Promise<void>
  /**
   * Watch a directory for live changes. `onChange` fires with a fresh listing
   * whenever the directory's contents change (file created/modified/deleted/
   * renamed), so the UI never needs a manual refresh. Returns an unsubscribe
   * function; call it to stop watching (safe to call before the watch has even
   * finished starting).
   */
  watch(path: string, onChange: (listing: DirListing) => void): () => void
}

/**
 * Bridge a "start (async) → stream events → stop" main-process watch into the
 * synchronous unsubscribe shape the UI wants. The watch id only exists after the
 * async start resolves, so we defer the subscription and honour an unsubscribe
 * that races ahead of it (cancelled before start resolves → stop immediately).
 */
function watchVia(
  start: (path: string) => Promise<string>,
  subscribe: (id: string, cb: (l: DirListing) => void) => () => void,
  unwatch: (id: string) => void
) {
  return (path: string, onChange: (l: DirListing) => void): (() => void) => {
    let cancelled = false
    let watchId: string | null = null
    let off: (() => void) | null = null
    start(path).then(
      (id) => {
        if (cancelled) return unwatch(id)
        watchId = id
        off = subscribe(id, onChange)
      },
      () => {} // start failed (e.g. session gone) — nothing to clean up
    )
    return () => {
      cancelled = true
      off?.()
      if (watchId) unwatch(watchId)
    }
  }
}

/** Local filesystem API surface. */
export function localFsApi(): FsApi {
  return {
    list: (p) => window.devterm.fs.list(p),
    home: () => window.devterm.fs.home(),
    mkdir: (p) => window.devterm.fs.mkdir(p),
    createFile: (p) => window.devterm.fs.createFile(p),
    rename: (a, b) => window.devterm.fs.rename(a, b),
    delete: (p) => window.devterm.fs.delete(p),
    watch: watchVia(
      (p) => window.devterm.fs.watch(p),
      window.devterm.fs.onWatchEvent,
      window.devterm.fs.unwatch
    )
  }
}

/** Remote SFTP API surface bound to a session. */
export function remoteFsApi(sessionId: string): FsApi {
  return {
    list: (p) => window.devterm.sftp.list(sessionId, p),
    home: () => window.devterm.sftp.home(sessionId),
    mkdir: (p) => window.devterm.sftp.mkdir(sessionId, p),
    createFile: (p) => window.devterm.sftp.createFile(sessionId, p),
    rename: (a, b) => window.devterm.sftp.rename(sessionId, a, b),
    delete: (p) => window.devterm.sftp.delete(sessionId, p),
    watch: watchVia(
      (p) => window.devterm.sftp.watch(sessionId, p),
      window.devterm.sftp.onWatchEvent,
      window.devterm.sftp.unwatch
    )
  }
}
