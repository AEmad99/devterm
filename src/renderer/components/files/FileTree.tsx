import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { FileEntry, GitFileStatus, GitStatus } from '@shared/types'
import type { FsApi } from '../../lib/fsapi'
import { IconChevron, IconFolder, IconFile, IconLink } from '../common/Icons'

/**
 * Identity key for a selected file. Paths are absolute within a single pane,
 * so a path string is unique enough. We compare with `samePath` to stay
 * separator-tolerant on Windows.
 */
export type Selection = Set<string>

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
 * Compute the path of `entry` relative to `root`, using the OS's separator
 * (and tolerating the alternate one, so a Windows root with forward-slash
 * children still resolves). Returns the full path as a fallback when `entry`
 * isn't under `root` (defensive — the explorer never feeds us a stray entry).
 */
function relPath(root: string, entry: string): string {
  const normRoot = root.replace(/[\\/]+$/, '')
  if (entry === normRoot) return ''
  if (entry.startsWith(normRoot + '\\') || entry.startsWith(normRoot + '/')) {
    return entry.slice(normRoot.length + 1)
  }
  return entry
}

function reachableOpenDirs(
  entries: FileEntry[],
  dirs: Record<string, DirState>,
  open: Set<string>
): Set<string> {
  const reachable = new Set<string>()
  const visit = (children: FileEntry[]) => {
    for (const e of children) {
      if (!e.isDir || !open.has(e.path)) continue
      reachable.add(e.path)
      const nested = dirs[e.path]?.entries
      if (nested) visit(nested)
    }
  }
  visit(entries)
  return reachable
}

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
    selectedPaths,
    onSelect,
    onMultiSelect,
    onActivateFile,
    onActivateDir,
    gitStatus,
    onRequestDiff
  }: {
    api: FsApi
    rootPath: string
    rootEntries: FileEntry[]
    /** Legacy single-select; kept for callers that don't multi-select. */
    selectedPath: string | null
    /**
     * Multi-select set. Wins over `selectedPath` when provided. Shift+click
     * extends the range from the anchor; Ctrl/Cmd+click toggles membership.
     */
    selectedPaths?: Selection
    onSelect: (entry: FileEntry) => void
    /**
     * Optional multi-select callback. Receives the updated set and the
     * click event so it can interpret modifier keys if it wants to.
     */
    onMultiSelect?: (next: Selection, ev: React.MouseEvent) => void
    onActivateFile: (entry: FileEntry) => void
    onActivateDir: (entry: FileEntry) => void
    /**
     * Optional live git status. When provided (and `isRepo`), we render a
     * small letter badge next to each filename and light up a right-click
     * "Show changes" action. Undefined = no git, no badges.
     */
    gitStatus?: GitStatus
    /**
     * Resolve a textual diff for a single file. The tree calls this when the
     * user invokes the "Show changes" right-click action; parent owns the
     * IPC hop so the tree stays unaware of the main/renderer boundary.
     */
    onRequestDiff?: (entry: FileEntry) => Promise<string>
  },
  ref: React.Ref<FileTreeHandle>
) {
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [dirs, setDirs] = useState<Record<string, DirState>>({})
  // Right-click "Show changes" → diff modal. Held locally so the tree is
  // self-contained for the diff action (the parent only provides the diff
  // resolver and the git status map).
  const [diffModal, setDiffModal] = useState<{ entry: FileEntry; text: string } | null>(null)
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

  // Root and nested listings can change underneath us (external delete/rename).
  // Keep only open dirs that still exist in the currently reachable tree; this
  // also lets the watch reconciliation below tear down dead watches.
  useEffect(() => {
    setOpen((prev) => {
      const reachable = reachableOpenDirs(rootEntries, dirsRef.current, prev)
      if (reachable.size === prev.size && [...prev].every((path) => reachable.has(path)))
        return prev
      return reachable
    })
    setDirs((prev) => {
      const reachable = reachableOpenDirs(rootEntries, prev, openRef.current)
      const next = Object.fromEntries(Object.entries(prev).filter(([path]) => reachable.has(path)))
      return Object.keys(next).length === Object.keys(prev).length ? prev : next
    })
  }, [rootEntries, dirs])

  // Live updates for expanded sub-directories: each open dir gets a watch so a
  // create/modify/delete/rename inside it is reflected without a refresh (the
  // parent owns the root listing's watch). Reconciles the active watch set to
  // whatever is currently expanded; collapsing or re-rooting tears watches down.
  const watchRefs = useRef<Map<string, () => void>>(new Map())
  useEffect(() => {
    const active = watchRefs.current
    for (const path of open) {
      if (active.has(path)) continue
      active.set(
        path,
        api.watch(path, (fresh) => {
          // Only refresh a dir we've actually loaded; leave loading/error alone.
          setDirs((d) => (d[path]?.entries ? { ...d, [path]: { entries: fresh.entries } } : d))
        })
      )
    }
    for (const [path, off] of active) {
      if (!open.has(path)) {
        off()
        active.delete(path)
      }
    }
  }, [open, api])

  // Tear every watch down on unmount.
  useEffect(() => {
    const active = watchRefs.current
    return () => {
      for (const off of active.values()) off()
      active.clear()
    }
  }, [])

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
      // Map an entry's absolute path to a repo-relative key for the badge.
      // rootPath is always an ancestor; the relative portion is what git
      // reports. For remote sessions where the path separator is '/', this
      // is exact; on local Windows we tolerate both.
      const rel = relPath(rootPath, e.path)
      const status: GitFileStatus | undefined = gitStatus?.isRepo
        ? gitStatus.entries[rel]
        : undefined
      const onContextMenu = (ev: React.MouseEvent) => {
        // Only meaningful for files inside a repo; directories get the default
        // browser context menu (no diff makes sense for them).
        if (!e.isDir && status && onRequestDiff) {
          ev.preventDefault()
          onSelect(e)
          onRequestDiff(e).then((text) => setDiffModal({ entry: e, text }))
        }
      }
      // Multi-select aware click. The parent owns the actual selection
      // model — we hand it the entry and the event so it can read modifier
      // keys; we always ALSO call the legacy onSelect so single-select
      // callers keep working.
      const isMulti = selectedPaths?.has(e.path) ?? false
      const isSel = isMulti || selectedPath === e.path
      const onRowClick = (ev: React.MouseEvent) => {
        if (onMultiSelect && (ev.shiftKey || ev.ctrlKey || ev.metaKey)) {
          ev.preventDefault()
          onMultiSelect(extendSelection(selectedPaths ?? new Set(), entries, e, ev), ev)
          return
        }
        onSelect(e)
        if (onMultiSelect) onMultiSelect(new Set([e.path]), ev)
      }
      acc.push(
        <div
          key={e.path}
          className={`tree-row ${isSel ? 'sel' : ''} ${
            status ? `git-${status.toLowerCase()}` : ''
          }`}
          style={{ paddingLeft: pad }}
          title={`${e.mode}${e.isDir ? '' : '  ' + e.size + ' B'}`}
          onClick={onRowClick}
          onDoubleClick={() => (e.isDir ? onActivateDir(e) : onActivateFile(e))}
          onContextMenu={onContextMenu}
          draggable
          onDragStart={(ev) => {
            // Allow this entry to be dropped onto a sibling pane to start
            // a transfer. The setData mime is the contract used by the
            // drop handler in SftpBrowser / FileExplorer.
            ev.dataTransfer.setData('application/x-devterm-path', e.path)
            ev.dataTransfer.setData('application/x-devterm-name', e.name)
            ev.dataTransfer.setData('application/x-devterm-isdir', e.isDir ? '1' : '0')
            ev.dataTransfer.effectAllowed = 'copyMove'
          }}
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
          <span
            className={`tree-icon ${e.isDir ? 'is-dir' : ''} ${e.isSymlink ? 'is-symlink' : ''}`}
          >
            {e.isDir ? (
              <IconFolder size={15} />
            ) : e.isSymlink ? (
              <IconLink size={15} />
            ) : (
              <IconFile size={15} />
            )}
          </span>
          <span className="tree-name">
            {e.name}
            {e.isSymlink && !e.isDir && (
              <span className="tree-symlink-arrow" title="Symbolic link">
                {'\u21AA'}
              </span>
            )}
          </span>
          {status && (
            <span
              className={`tree-git-badge git-${status.toLowerCase()}`}
              title={`git status: ${status}`}
            >
              {status}
            </span>
          )}
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
  return (
    <div className="file-tree">
      {rows}
      {diffModal && (
        <div className="modal-backdrop" onClick={() => setDiffModal(null)}>
          <div className="modal git-diff-modal" onClick={(ev) => ev.stopPropagation()}>
            <h3>Changes — {diffModal.entry.name}</h3>
            <pre className="git-diff-pre">
              {diffModal.text.trim() ? diffModal.text : '(no diff)'}
            </pre>
            <div className="actions">
              <button type="button" onClick={() => setDiffModal(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

const FileTree = forwardRef(FileTreeImpl)
export default FileTree

/**
 * Compute the next multi-select set after a click on `clicked`.
 *  - Plain click: replace with { clicked }.
 *  - Ctrl/Cmd-click: toggle membership.
 *  - Shift-click: extend the range from the last anchor (or the previous
 *    selection's last item) to the clicked entry, both inclusive.
 */
function extendSelection(
  prev: Selection,
  visibleSiblings: FileEntry[],
  clicked: FileEntry,
  ev: React.MouseEvent
): Selection {
  const next = new Set(prev)
  if (ev.shiftKey) {
    // Find the anchor: the last item of the existing selection, or the
    // clicked entry itself when nothing is selected.
    const siblingPaths = visibleSiblings.map((s) => s.path)
    const clickedIdx = siblingPaths.indexOf(clicked.path)
    if (clickedIdx < 0) return new Set([clicked.path])
    let anchorIdx = -1
    for (let i = prev.size; i > 0; i--) {
      // Find the highest-index sibling in the current selection
      const last = [...prev].reverse().find((p) => siblingPaths.includes(p))
      if (last) {
        anchorIdx = siblingPaths.indexOf(last)
        break
      }
    }
    if (anchorIdx < 0) anchorIdx = clickedIdx
    const [from, to] = anchorIdx <= clickedIdx ? [anchorIdx, clickedIdx] : [clickedIdx, anchorIdx]
    for (let i = from; i <= to; i++) next.add(siblingPaths[i])
    return next
  }
  if (ev.ctrlKey || ev.metaKey) {
    if (next.has(clicked.path)) next.delete(clicked.path)
    else next.add(clicked.path)
    return next
  }
  return new Set([clicked.path])
}
