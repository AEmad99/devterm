import { promises as fs } from 'fs'
import os from 'os'
import { dirname, join, normalize } from 'path'
import type { DirListing, FileContent, FileEntry } from '@shared/types'
import { MAX_EDIT_BYTES } from '@shared/types'
import { formatMode } from './format'
import { decodeText, detectEol, encodeText, looksBinary } from './content'

export function localHome(): string {
  return os.homedir()
}

export async function listLocal(dir?: string): Promise<DirListing> {
  const path = dir && dir.trim() ? normalize(dir) : localHome()
  const names = await fs.readdir(path)
  const entries: FileEntry[] = []
  for (const name of names) {
    const full = join(path, name)
    try {
      const lst = await fs.lstat(full)
      const isSymlink = lst.isSymbolicLink()
      // Resolve symlink target to know if it behaves as a directory.
      const st = isSymlink ? await fs.stat(full).catch(() => lst) : lst
      const isDir = st.isDirectory()
      entries.push({
        name,
        path: full,
        isDir,
        isSymlink,
        size: st.size,
        mtimeMs: st.mtimeMs,
        mode: formatMode(lst.mode, isDir, isSymlink)
      })
    } catch {
      // Unreadable entry (permissions, broken link) — list it minimally.
      entries.push({
        name,
        path: full,
        isDir: false,
        isSymlink: false,
        size: 0,
        mtimeMs: 0,
        mode: '----------'
      })
    }
  }
  entries.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1))
  const parent = dirname(path)
  return { path, parent: parent === path ? null : parent, entries }
}

export async function mkdirLocal(path: string): Promise<void> {
  await fs.mkdir(path, { recursive: false })
}

/** Create an empty file. The `wx` flag fails (EEXIST) if anything already exists there. */
export async function createFileLocal(path: string): Promise<void> {
  await fs.writeFile(path, '', { flag: 'wx' })
}

export async function renameLocal(from: string, to: string): Promise<void> {
  await fs.rename(from, to)
}

export async function deleteLocal(path: string): Promise<void> {
  await fs.rm(path, { recursive: true, force: true })
}

export async function readFileLocal(path: string): Promise<FileContent> {
  const p = normalize(path)
  const st = await fs.stat(p)
  if (st.isDirectory()) throw new Error('Cannot open a directory in the editor')
  if (st.size > MAX_EDIT_BYTES)
    throw new Error(
      `File is too large to edit (${Math.round(st.size / 1024 / 1024)} MB; limit ${MAX_EDIT_BYTES / 1024 / 1024} MB)`
    )
  const buf = await fs.readFile(p)
  if (looksBinary(buf)) throw new Error('File appears to be binary and cannot be edited as text')
  const content = decodeText(buf)
  return { path: p, content, size: st.size, mtimeMs: st.mtimeMs, eol: detectEol(content) }
}

export async function writeFileLocal(
  path: string,
  content: string
): Promise<{ mtimeMs: number; size: number }> {
  const p = normalize(path)
  const buf = encodeText(content)
  await fs.writeFile(p, buf)
  const st = await fs.stat(p)
  return { mtimeMs: st.mtimeMs, size: st.size }
}
