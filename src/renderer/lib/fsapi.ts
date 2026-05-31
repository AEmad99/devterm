import type { FsApi } from '../components/FilePane'

/** Local filesystem API surface. */
export function localFsApi(): FsApi {
  return {
    list: (p) => window.devterm.fs.list(p),
    home: () => window.devterm.fs.home(),
    mkdir: (p) => window.devterm.fs.mkdir(p),
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
    rename: (a, b) => window.devterm.sftp.rename(sessionId, a, b),
    delete: (p) => window.devterm.sftp.delete(sessionId, p)
  }
}
