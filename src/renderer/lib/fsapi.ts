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
}

/** Local filesystem API surface. */
export function localFsApi(): FsApi {
  return {
    list: (p) => window.devterm.fs.list(p),
    home: () => window.devterm.fs.home(),
    mkdir: (p) => window.devterm.fs.mkdir(p),
    createFile: (p) => window.devterm.fs.createFile(p),
    rename: (a, b) => window.devterm.fs.rename(a, b),
    delete: (p) => window.devterm.fs.delete(p)
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
    delete: (p) => window.devterm.sftp.delete(sessionId, p)
  }
}
