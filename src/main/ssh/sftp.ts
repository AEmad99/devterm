import { posix } from 'path'
import type { SFTPWrapper, Stats } from 'ssh2'
import type { DirListing, FileContent, FileEntry } from '@shared/types'
import { MAX_EDIT_BYTES } from '@shared/types'
import { formatMode, S_IFDIR, S_IFLNK, S_IFMT } from '../fs/format'
import { decodeText, detectEol, encodeText, looksBinary } from '../fs/content'

const promise = <T>(
  fn: (cb: (err: Error | null | undefined, res: T) => void) => void
): Promise<T> => new Promise((resolve, reject) => fn((err, res) => (err ? reject(err) : resolve(res))))

function isDirMode(mode: number): boolean {
  return (mode & S_IFMT) === S_IFDIR
}
function isLinkMode(mode: number): boolean {
  return (mode & S_IFMT) === S_IFLNK
}

export function sftpHome(sftp: SFTPWrapper): Promise<string> {
  return promise<string>((cb) => sftp.realpath('.', cb))
}

export async function listRemote(sftp: SFTPWrapper, dir?: string): Promise<DirListing> {
  const path = dir && dir.trim() ? posix.normalize(dir) : await sftpHome(sftp)
  const list = await promise<{ filename: string; longname: string; attrs: Stats }[]>((cb) =>
    sftp.readdir(path, cb)
  )
  const entries: FileEntry[] = list
    .filter((e) => e.filename !== '.' && e.filename !== '..')
    .map((e) => {
      const mode = e.attrs.mode ?? 0
      const isSymlink = isLinkMode(mode)
      const isDir = isDirMode(mode)
      return {
        name: e.filename,
        path: posix.join(path, e.filename),
        isDir,
        isSymlink,
        size: e.attrs.size ?? 0,
        mtimeMs: (e.attrs.mtime ?? 0) * 1000,
        mode: formatMode(mode, isDir, isSymlink)
      }
    })
    .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1))

  return { path, parent: path === '/' ? null : posix.dirname(path), entries }
}

export function statRemote(sftp: SFTPWrapper, path: string): Promise<Stats> {
  return promise<Stats>((cb) => sftp.stat(path, cb))
}

export async function readFileRemote(sftp: SFTPWrapper, path: string): Promise<FileContent> {
  const p = posix.normalize(path)
  const st = await statRemote(sftp, p)
  if (isDirMode(st.mode ?? 0)) throw new Error('Cannot open a directory in the editor')
  const size = st.size ?? 0
  if (size > MAX_EDIT_BYTES)
    throw new Error(
      `File is too large to edit (${Math.round(size / 1024 / 1024)} MB; limit ${MAX_EDIT_BYTES / 1024 / 1024} MB)`
    )
  const buf = await promise<Buffer>((cb) => sftp.readFile(p, (err, data) => cb(err, data)))
  if (looksBinary(buf)) throw new Error('File appears to be binary and cannot be edited as text')
  const content = decodeText(buf)
  return { path: p, content, size: buf.length, mtimeMs: (st.mtime ?? 0) * 1000, eol: detectEol(content) }
}

export async function writeFileRemote(
  sftp: SFTPWrapper,
  path: string,
  content: string
): Promise<{ mtimeMs: number; size: number }> {
  const p = posix.normalize(path)
  const buf = encodeText(content)
  await promise<void>((cb) => sftp.writeFile(p, buf, (err) => cb(err, undefined)))
  const st = await statRemote(sftp, p)
  return { mtimeMs: (st.mtime ?? 0) * 1000, size: st.size ?? buf.length }
}

export function mkdirRemote(sftp: SFTPWrapper, path: string): Promise<void> {
  return promise<void>((cb) => sftp.mkdir(path, cb))
}

export function renameRemote(sftp: SFTPWrapper, from: string, to: string): Promise<void> {
  return promise<void>((cb) => sftp.rename(from, to, cb))
}

/** Recursively remove a remote file or directory. */
export async function deleteRemote(sftp: SFTPWrapper, path: string): Promise<void> {
  const st = await promise<Stats>((cb) => sftp.lstat(path, cb))
  if (isDirMode(st.mode ?? 0)) {
    const children = await promise<{ filename: string }[]>((cb) => sftp.readdir(path, cb))
    for (const c of children) {
      if (c.filename === '.' || c.filename === '..') continue
      await deleteRemote(sftp, posix.join(path, c.filename))
    }
    await promise<void>((cb) => sftp.rmdir(path, cb))
  } else {
    await promise<void>((cb) => sftp.unlink(path, cb))
  }
}
