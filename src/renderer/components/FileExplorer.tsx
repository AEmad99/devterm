import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DirListing, FileEntry, GitStatus } from '@shared/types'
import { useSessions } from '../store/sessions'
import { useEditors } from '../store/editors'
import { localFsApi, remoteFsApi, type FsApi } from '../lib/fsapi'
import FileTree, { type FileTreeHandle, type Selection } from './FileTree'
import {
  IconLocal,
  IconRemote,
  IconRefresh,
  IconArrowUp,
  IconHome,
  IconFile,
  IconPlus,
  IconEdit,
  IconTrash
} from './Icons'

/** Strip a trailing path separator. */
const strip = (p: string) => p.replace(/[/\\]+$/, '')
const childOf = (dir: string, name: string, sep: string) => strip(dir) + sep + name
function parentDir(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  if (i > 0) return p.slice(0, i)
  if (i === 0) return p.slice(0, 1)
  return strip(p)
}
const samePath = (a: string, b: string) => strip(a) === strip(b)
function basename(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i >= 0 ? p.slice(i + 1) : p
}

/**
 * Persistent left side-panel file explorer for the active session. It follows
 * the shell's working directory (reported via OSC 7 into the session store) and
 * also supports manual navigation, refresh, and create/rename/delete. Folders
 * expand inline as a tree. Local sessions browse the local filesystem; remote
 * sessions browse over SFTP.
 */
export default function FileExplorer() {
  const active = useSessions((s) => s.sessions.find((x) => x.id === s.activeId))
  const kind = active?.kind
  const cwd = active?.cwd
  const isPending = !active || active.id.startsWith('pending-')
  // Browser panes have no filesystem; the explorer shows a placeholder for them.
  const isBrowser = active?.kind === 'browser'
  const sep = kind === 'remote' ? '/' : window.devterm.platform === 'win32' ? '\\' : '/'

  const api = useMemo<FsApi | null>(() => {
    if (isPending || !active || active.kind === 'browser') return null
    return active.kind === 'remote' ? remoteFsApi(active.id) : localFsApi()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id, kind, isPending])

  const openEditor = useEditors((s) => s.open)
  const [listing, setListing] = useState<DirListing | null>(null)
  const [sel, setSel] = useState<FileEntry | null>(null)
  const [multiSel, setMultiSel] = useState<Selection>(new Set())
  const [dropActive, setDropActive] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [pathInput, setPathInput] = useState('')
  const loadedPath = useRef<string | null>(null)
  const treeRef = useRef<FileTreeHandle>(null)
  // Git status for the currently shown directory. `null` means "not yet known"
  // (loading), a populated object with `isRepo: false` means "known to be a
  // non-repo". The state is per-session/per-path so navigating away clears it
  // and re-entering kicks off a fresh fetch.
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null)
  // UI-only filter toggle. Per task spec this lives in component state, not
  // userData — it represents the user's transient focus in this session.
  const [showChangesOnly, setShowChangesOnly] = useState(false)
  // Fuzzy search state — opened by pressing `/` while the tree is focused.
  const [search, setSearch] = useState<{ q: string; match: string | null } | null>(null)

  const load = useCallback(
    async (path?: string) => {
      if (!api) return
      setErr(null)
      try {
        const l = await api.list(path)
        loadedPath.current = l.path
        setListing(l)
        setSel(null)
        setMultiSel(new Set())
      } catch (e) {
        setErr(String((e as Error).message || e))
      }
    },
    [api]
  )

  // When the active session changes, reset and load its cwd (or home).
  useEffect(() => {
    setListing(null)
    setSel(null)
    setMultiSel(new Set())
    loadedPath.current = null
    setGitStatus(null)
    if (api) {
      if (cwd) load(cwd)
      else load()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id])

  // Follow the shell: when cwd changes (and differs from what's shown), navigate.
  useEffect(() => {
    if (api && cwd && cwd !== loadedPath.current) load(cwd)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd])

  // Keep the editable path box in sync with the directory being shown.
  useEffect(() => {
    if (listing) setPathInput(listing.path)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listing?.path])

  // Git status: lazy-fetch when the shown path changes; live-push updates via
  // the watch channel. We never block the tree render on this — the listing
  // paints immediately and git fills in once it returns.
  const sessionId = active?.kind === 'remote' ? active.id : undefined
  useEffect(() => {
    const p = listing?.path
    if (!api || !p) return
    let cancelled = false
    const target = { sessionId, path: p }
    setGitStatus(null)
    void window.devterm.git.status(target).then((s) => {
      if (!cancelled) setGitStatus(s)
    })
    // Subscribe to live updates. The preload wrapper returns an unsubscribe
    // that also tells main to stop polling when no renderers care anymore.
    window.devterm.git.watch(target)
    const off = window.devterm.git.onChange(p, (s) => {
      if (!cancelled) setGitStatus(s)
    })
    return () => {
      cancelled = true
      off()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listing?.path, sessionId])

  // Live updates: reflect create / modify / delete / rename in the shown
  // directory automatically. Main only pushes when the contents actually change,
  // so the selection is preserved unless the selected entry itself disappears.
  useEffect(() => {
    const path = listing?.path
    if (!api || !path) return
    const off = api.watch(path, (fresh) => {
      if (!samePath(fresh.path, loadedPath.current ?? '')) return
      setListing(fresh)
      setSel((cur) => (cur && fresh.entries.some((e) => samePath(e.path, cur.path)) ? cur : null))
      setMultiSel((cur) => {
        if (cur.size === 0) return cur
        const next = new Set<string>()
        for (const p of cur) {
          if (fresh.entries.some((e) => samePath(e.path, p))) next.add(p)
        }
        return next
      })
    })
    return off
  }, [api, listing?.path])

  const openEntryEditor = (e: FileEntry) => {
    if (e.isSymlink || !active || active.kind === 'browser') return
    openEditor({
      scope: active.kind === 'remote' ? 'remote' : 'local',
      sessionId: active.kind === 'remote' ? active.id : undefined,
      path: e.path
    })
  }

  // New items go inside the selected folder when one is picked, else the root.
  const createDir = sel?.isDir ? sel.path : (listing?.path ?? '')

  // Diff resolver for the right-click "Show changes" action. Runs over the
  // same channel the status lookup uses (sessionId-aware), so remotes work
  // the same way locals do.
  const requestDiff = useCallback(
    async (entry: FileEntry): Promise<string> => {
      if (!listing) return ''
      const rel = (() => {
        const norm = listing.path.replace(/[\\/]+$/, '')
        if (entry.path === norm) return entry.name
        if (entry.path.startsWith(norm + '\\') || entry.path.startsWith(norm + '/'))
          return entry.path.slice(norm.length + 1)
        return entry.name
      })()
      return window.devterm.git.diff({ sessionId, path: listing.path, file: rel })
    },
    [listing, sessionId]
  )

  const [dialog, setDialog] = useState<null | {
    kind: 'mkdir' | 'newfile' | 'rename' | 'delete'
    value: string
  }>(null)
  const [busy, setBusy] = useState(false)

  // Apply the "Show changes only" filter. We don't mutate `listing`; the
  // `FileTree` re-renders a filtered view via `rootEntries`. Untracked files
  // AND directories that contain no changes are hidden — keeps the focus on
  // the actual diff surface, like VS Code's "Modified Files" filter.
  const filteredEntries = useMemo(() => {
    const base = listing?.entries ?? []
    if (!showChangesOnly || !gitStatus?.isRepo) return base
    const changed = new Set(Object.keys(gitStatus.entries))
    if (changed.size === 0) return []
    return base.filter((e) => {
      if (changed.has(e.name)) return true
      // Show directories that might contain changed files (we don't recurse
      // here; the tree will lazy-expand and apply the same predicate).
      return e.isDir
    })
  }, [listing?.entries, showChangesOnly, gitStatus])

  // Fuzzy match: open with `/` from the tree, type a substring, Enter focuses
  // the match. Case-insensitive "every query char appears in order in the
  // name" — tiny by design, no third-party fuzzer.
  const fuzzyMatch = useCallback((name: string, q: string): boolean => {
    if (!q) return true
    const n = name.toLowerCase()
    let i = 0
    for (const ch of q.toLowerCase()) {
      const found = n.indexOf(ch, i)
      if (found === -1) return false
      i = found + 1
    }
    return true
  }, [])

  // Recompute the highlighted match path whenever the query or the listing
  // changes. We pick the first visible entry (top-down, dirs first) whose
  // name matches; null means no hit.
  useEffect(() => {
    if (!search) return
    const base = filteredEntries
    const hit = base.find((e) => fuzzyMatch(e.name, search.q))
    setSearch((cur) => (cur ? { ...cur, match: hit ? hit.path : null } : cur))
  }, [search?.q, filteredEntries, fuzzyMatch])

  const refreshDir = async (dir: string) => {
    if (listing && samePath(dir, listing.path)) await load(listing.path)
    else await treeRef.current?.openDir(dir)
  }

  const submitDialog = async () => {
    if (!dialog || !api || !listing) return
    setBusy(true)
    try {
      const name = dialog.value.trim()
      if (dialog.kind === 'mkdir' && name) {
        await api.mkdir(childOf(createDir, name, sep))
        await refreshDir(createDir)
      } else if (dialog.kind === 'newfile' && name) {
        await api.createFile(childOf(createDir, name, sep))
        await refreshDir(createDir)
      } else if (dialog.kind === 'rename' && sel && name && name !== sel.name) {
        const parent = parentDir(sel.path)
        await api.rename(sel.path, childOf(parent, name, sep))
        setSel(null)
        await refreshDir(parent)
      } else if (dialog.kind === 'delete' && sel) {
        const parent = parentDir(sel.path)
        await api.delete(sel.path)
        setSel(null)
        await refreshDir(parent)
      }
      setDialog(null)
    } catch (e) {
      setErr(`${dialog.kind} failed: ${(e as Error).message}`)
      setDialog(null)
    } finally {
      setBusy(false)
    }
  }

  // `/` opens the in-tree search, Esc cancels it. The handler is on the
  // explorer's root container so it fires only when the explorer (or a
  // descendant) has focus — never while typing into the editor or terminal.
  const onExplorerKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape' && search) {
      e.preventDefault()
      setSearch(null)
      return
    }
    if (e.key === 'Enter' && search && search.match) {
      e.preventDefault()
      const match = listing?.entries.find((x) => x.path === search.match)
      if (match) {
        if (match.isDir) {
          // Open the directory so the user can drill in.
          void treeRef.current?.openDir(match.path)
        } else {
          // Focus the file: select it, then open in editor.
          setSel(match)
          openEntryEditor(match)
        }
      }
      setSearch(null)
      return
    }
    if (e.key === '/' && !search) {
      // Don't hijack the slash when the user is typing into the path input.
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      e.preventDefault()
      setSearch({ q: '', match: null })
    }
  }

  if (isPending || isBrowser) {
    return (
      <div className="explorer">
        <div className="explorer-head">Files</div>
        <div className="explorer-empty">
          {isBrowser ? 'No files for browser tabs' : active ? 'connecting…' : 'No active session'}
        </div>
      </div>
    )
  }

  return (
    <div className="explorer">
      <div className="explorer-head">
        <span className="ex-kind">
          {kind === 'remote' ? <IconRemote size={14} /> : <IconLocal size={14} />}
          {kind === 'remote' ? 'Remote' : 'Local'}
        </span>
        <span className="spacer" />
        <button
          className="icon-btn"
          title="New file"
          onClick={() => setDialog({ kind: 'newfile', value: '' })}
        >
          <IconFile size={14} />
        </button>
        <button
          className="icon-btn"
          title="New folder"
          onClick={() => setDialog({ kind: 'mkdir', value: '' })}
        >
          <IconPlus size={14} />
        </button>
        <button
          className="icon-btn"
          title="Rename"
          disabled={!sel}
          onClick={() => sel && setDialog({ kind: 'rename', value: sel.name })}
        >
          <IconEdit size={14} />
        </button>
        <button
          className="icon-btn danger"
          title="Delete"
          disabled={!sel}
          onClick={() => sel && setDialog({ kind: 'delete', value: sel.name })}
        >
          <IconTrash size={14} />
        </button>
        <button
          className="icon-btn"
          title="Refresh"
          onClick={() => load(loadedPath.current || undefined)}
        >
          <IconRefresh size={14} />
        </button>
      </div>
      <div className="explorer-pathbar" title={listing?.path}>
        <button
          className="icon-btn"
          title="Up"
          disabled={!listing?.parent}
          onClick={() => listing?.parent && load(listing.parent)}
        >
          <IconArrowUp size={14} />
        </button>
        <button className="icon-btn" title="Home" onClick={() => load()}>
          <IconHome size={14} />
        </button>
        <form
          className="ex-pathform"
          onSubmit={(e) => {
            e.preventDefault()
            const p = pathInput.trim()
            if (p) load(p)
          }}
        >
          <input
            className="ex-path-input"
            value={pathInput}
            spellCheck={false}
            placeholder="path…"
            title="Type a path and press Enter to jump there"
            onChange={(e) => setPathInput(e.target.value)}
          />
        </form>
      </div>
      {err && <div className="explorer-error">{err}</div>}
      <div
        className={`explorer-list ${dropActive ? 'drop-target' : ''}`}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('application/x-devterm-path')) {
            e.preventDefault()
            e.dataTransfer.dropEffect = 'copy'
            if (!dropActive) setDropActive(true)
          }
        }}
        onDragLeave={() => setDropActive(false)}
        onDrop={(e) => {
          const dropped = e.dataTransfer.getData('application/x-devterm-path')
          if (!dropped) return
          e.preventDefault()
          setDropActive(false)
          // Drop on the explorer's tree = open the file in the editor. This
          // gives drag-from-anywhere-into-the-tree a sensible action; a
          // real transfer target is the SFTP browser (which has both panes).
          const name = e.dataTransfer.getData('application/x-devterm-name') || basename(dropped)
          const isDir = e.dataTransfer.getData('application/x-devterm-isdir') === '1'
          if (isDir) return
          if (!active) return
          openEntryEditor({
            name,
            path: dropped,
            isDir: false,
            isSymlink: false,
            size: 0,
            mtimeMs: 0,
            mode: '-'
          })
        }}
      >
        {listing && api && (
          <FileTree
            ref={treeRef}
            api={api}
            rootPath={listing.path}
            rootEntries={listing.entries}
            selectedPath={sel?.path ?? null}
            selectedPaths={multiSel}
            onSelect={setSel}
            onMultiSelect={setMultiSel}
            onActivateFile={openEntryEditor}
            onActivateDir={(e) => load(e.path)}
          />
        )}
        {listing && listing.entries.length === 0 && <div className="explorer-empty">(empty)</div>}
        {!listing && !err && <div className="explorer-empty">loading…</div>}
      </div>

      {dialog && (
        <div className="modal-backdrop" onClick={() => !busy && setDialog(null)}>
          <form
            className="modal fp-dialog"
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault()
              submitDialog()
            }}
          >
            {dialog.kind === 'delete' ? (
              <>
                <h3>Delete</h3>
                <p>
                  Permanently delete <b>{dialog.value}</b>
                  {sel?.isDir ? ' and everything inside it' : ''}? This cannot be undone.
                </p>
                <div className="actions">
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => setDialog(null)}
                    disabled={busy}
                  >
                    Cancel
                  </button>
                  <button type="submit" className="danger-btn" disabled={busy}>
                    Delete
                  </button>
                </div>
              </>
            ) : (
              <>
                <h3>
                  {dialog.kind === 'mkdir'
                    ? 'New folder'
                    : dialog.kind === 'newfile'
                      ? 'New file'
                      : 'Rename'}
                </h3>
                <label>
                  {dialog.kind === 'rename'
                    ? 'New name'
                    : dialog.kind === 'newfile'
                      ? 'File name'
                      : 'Folder name'}
                  <input
                    autoFocus
                    value={dialog.value}
                    disabled={busy}
                    onChange={(e) => setDialog({ ...dialog, value: e.target.value })}
                  />
                </label>
                <div className="actions">
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => setDialog(null)}
                    disabled={busy}
                  >
                    Cancel
                  </button>
                  <button type="submit" disabled={busy || !dialog.value.trim()}>
                    {dialog.kind === 'rename' ? 'Rename' : 'Create'}
                  </button>
                </div>
              </>
            )}
          </form>
        </div>
      )}
    </div>
  )
}
