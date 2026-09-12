import type { FileEntry } from '@shared/types'

/**
 * Shared sorting + filtering for the file views (sidebar explorer and the
 * SFTP dual-pane browser). Both render through `FileTree`, which applies
 * these helpers at every tree level so nested folders sort/filter the same
 * way the root does. Pure functions — safe to unit test in node.
 */

export type FileSortKey = 'name' | 'size' | 'modified' | 'type'
export type FileSortDir = 'asc' | 'desc'

export interface FileSortPrefs {
  key: FileSortKey
  dir: FileSortDir
  /** List folders before files (within each group the key/dir still apply). */
  dirsFirst: boolean
}

export const DEFAULT_FILE_SORT: FileSortPrefs = { key: 'name', dir: 'asc', dirsFirst: true }

export const FILE_SORT_KEYS: { value: FileSortKey; label: string }[] = [
  { value: 'name', label: 'Name' },
  { value: 'size', label: 'Size' },
  { value: 'modified', label: 'Modified' },
  { value: 'type', label: 'Type' }
]

/** Lower-cased extension without the dot; '' for extensionless/dotfiles. */
export function fileTypeKey(name: string): string {
  const i = name.lastIndexOf('.')
  if (i <= 0 || i === name.length - 1) return ''
  return name.slice(i + 1).toLowerCase()
}

function compareNames(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
}

/**
 * Return a sorted copy of `entries`. Ties on size/modified/type fall back to
 * name so the order is deterministic; the direction applies to the whole
 * comparison (including the name tie-break).
 */
export function sortFileEntries(
  entries: FileEntry[],
  prefs: FileSortPrefs = DEFAULT_FILE_SORT
): FileEntry[] {
  const { key, dir, dirsFirst } = prefs
  const sign = dir === 'desc' ? -1 : 1
  return [...entries].sort((a, b) => {
    if (dirsFirst && a.isDir !== b.isDir) return a.isDir ? -1 : 1
    let c: number
    switch (key) {
      case 'size':
        c = a.size - b.size
        break
      case 'modified':
        c = a.mtimeMs - b.mtimeMs
        break
      case 'type':
        c = compareNames(fileTypeKey(a.name), fileTypeKey(b.name))
        break
      case 'name':
      default:
        c = compareNames(a.name, b.name)
        break
    }
    if (c === 0 && key !== 'name') c = compareNames(a.name, b.name)
    return c * sign
  })
}

/**
 * Keep entries whose name contains `query` (case-insensitive substring).
 * A blank query returns the input array untouched.
 */
export function filterFileEntries(entries: FileEntry[], query: string): FileEntry[] {
  const q = query.trim().toLowerCase()
  if (!q) return entries
  return entries.filter((e) => e.name.toLowerCase().includes(q))
}

const PREFS_KEY = 'devterm.fileSort.v1'

function isFileSortKey(v: unknown): v is FileSortKey {
  return v === 'name' || v === 'size' || v === 'modified' || v === 'type'
}

/** Load persisted sort prefs; falls back to defaults on any failure. */
export function loadFileSortPrefs(): FileSortPrefs {
  try {
    if (typeof localStorage === 'undefined') return { ...DEFAULT_FILE_SORT }
    const raw = localStorage.getItem(PREFS_KEY)
    if (!raw) return { ...DEFAULT_FILE_SORT }
    const p = JSON.parse(raw) as Partial<FileSortPrefs>
    return {
      key: isFileSortKey(p.key) ? p.key : DEFAULT_FILE_SORT.key,
      dir: p.dir === 'desc' ? 'desc' : 'asc',
      dirsFirst: p.dirsFirst === false ? false : true
    }
  } catch {
    return { ...DEFAULT_FILE_SORT }
  }
}

/** Persist sort prefs (best-effort — never throws). */
export function saveFileSortPrefs(prefs: FileSortPrefs): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
  } catch {
    // Private-mode / quota — sorting still works for the session.
  }
}
