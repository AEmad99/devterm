import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { FileEntry } from '@shared/types'
import type { FsApi } from '../lib/fsapi'
import { IconChevron, IconFolder, IconFile, IconLink } from './Icons'

/** Imperative handle so a parent can refresh a sub-directory after a mutation. */
export interface FileTreeHandle {
  /** Refetch the children of an already-expanded directory (no-op otherwise). */
  reload(path: string): Promise<void>
  /** Expand a directory (loading it if needed), e.g. to reveal a freshly created item. */
  openDir(path: string): Promise<void>
}

/** Lazily-loaded state for one expanded directory (depth ≥ 1; the root is owned by the parent). */
interface DirState {
  entries?: FileEntry[]
  loading?: boolean
  error?: string
}

const INDENT = 14 // px added per nesting level
const BASE_PAD = 6 // px left padding at depth 0

/**
 * A collapsible filesystem tree. The PARENT owns the root directory listing
 * (so follow-cwd / reload / transfer logic stays put) and passes its entries in
 * via `rootEntries`; this component only manages inline expansion of nested
 * folders (depth ≥ 1), lazily listing each via `api.list` on first open.
 *
 * Disclosure arrow: points down when collapsed (click to expand), up when
 * expanded (click to collapse).
 */
function FileTreeImpl(
  {
    api,
    rootPath,
    rootEntries,
    selectedPath,
    onSelect,
    onActivateFile,
    onActivateDir
  }: {
    api: FsApi
    rootPath: string
    rootEntries: FileEntry[]
    selectedPath: string | null
    onSelect: (entry: FileEntry) => void
    onActivateFile: (entry: FileEntry) => void
    onActivateDir: (entry: FileEntry) => void
  },
  ref: React.Ref<FileTreeHandle>
) {
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [dirs, setDirs] = useState<Record<string, DirState>>({})
  // Mirrors of the latest state, so `toggle` can decide whether to lazy-load
  // without reading stale closures or nesting setState calls.
  const openRef = useRef(open)
  openRef.current = open
  const dirsRef = useRef(dirs)
  dirsRef.current = dirs

  // Re-rooting (navigate / follow-cwd) discards all nested expansion + caches.
  // Keyed on rootPath only, so a same-directory reload (new rootEntries) keeps
  // whatever the user had expanded.
  useEffect(() => {
    setOpen(new Set())
    setDirs({})
  }, [rootPath])

  const fetchDir = useCallback(
    async (path: string) => {
      setDirs((d) => ({ ...d, [path]: { ...d[path], loading: true, error: undefined } }))
      try {
        const listing = await api.list(path)
        setDirs((d) => ({ ...d, [path]: { entries: listing.entries, loading: false } }))
      } catch (e) {
        setDirs((d) => ({
          ...d,
          [path]: { ...d[path], loading: false, error: String((e as Error).message || e) }
        }))
      }
    },
    [api]
  )

  const toggle = useCallback(
    (path: string) => {
      const willOpen = !openRef.current.has(path)
      setOpen((prev) => {
        const next = new Set(prev)
        if (next.has(path)) next.delete(path)
        else next.add(path)
        return next
      })
      // Lazy-load on first expand (decided from the live ref, fetched outside the updater).
      if (willOpen) {
        const cur = dirsRef.current[path]
        if (!cur?.entries && !cur?.loading) void fetchDir(path)
      }
    },
    [fetchDir]
  )

  useImperativeHandle(
    ref,
    () => ({
      reload: async (path: string) => {
        // Only refetch directories that were actually expanded/loaded here.
        const cur = dirsRef.current[path]
        if (cur?.entries || cur?.loading) await fetchDir(path)
      },
      openDir: async (path: string) => {
        setOpen((prev) => (prev.has(path) ? prev : new Set(prev).add(path)))
        await fetchDir(path)
      }
    }),
    [fetchDir]
  )

  const renderRows = (entries: FileEntry[], depth: number, acc: React.ReactNode[]): void => {
    for (const e of entries) {
      const expanded = e.isDir && open.has(e.path)
      const pad = BASE_PAD + depth * INDENT
      acc.push(
        <div
          key={e.path}
          className={`tree-row ${selectedPath === e.path ? 'sel' : ''}`}
          style={{ paddingLeft: pad }}
          title={`${e.mode}${e.isDir ? '' : '  ' + e.size + ' B'}`}
          onClick={() => onSelect(e)}
          onDoubleClick={() => (e.isDir ? onActivateDir(e) : onActivateFile(e))}
        >
          {e.isDir ? (
            <button
              className={`tree-twisty ${expanded ? 'open' : ''}`}
              title={expanded ? 'Collapse' : 'Expand'}
              onClick={(ev) => {
                ev.stopPropagation()
                toggle(e.path)
              }}
            >
              <IconChevron size={13} />
            </button>
          ) : (
            <span className="tree-twisty spacer" />
          )}
          <span className={`tree-icon ${e.isDir ? 'is-dir' : ''}`}>
            {e.isDir ? (
              <IconFolder size={15} />
            ) : e.isSymlink ? (
              <IconLink size={15} />
            ) : (
              <IconFile size={15} />
            )}
          </span>
          <span className="tree-name">{e.name}</span>
        </div>
      )
      if (expanded) {
        const state = dirs[e.path]
        const childPad = BASE_PAD + (depth + 1) * INDENT
        if (state?.loading) {
          acc.push(
            <div key={e.path + '::loading'} className="tree-note" style={{ paddingLeft: childPad }}>
              loading…
            </div>
          )
        } else if (state?.error) {
          acc.push(
            <div
              key={e.path + '::error'}
              className="tree-note error"
              style={{ paddingLeft: childPad }}
            >
              {state.error}
            </div>
          )
        } else if (state?.entries) {
          if (state.entries.length === 0) {
            acc.push(
              <div key={e.path + '::empty'} className="tree-note" style={{ paddingLeft: childPad }}>
                (empty)
              </div>
            )
          } else {
            renderRows(state.entries, depth + 1, acc)
          }
        }
      }
    }
  }

  const rows: React.ReactNode[] = []
  renderRows(rootEntries, 0, rows)
  return <div className="file-tree">{rows}</div>
}

const FileTree = forwardRef(FileTreeImpl)
export default FileTree
