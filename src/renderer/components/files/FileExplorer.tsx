import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DirListing, FileEntry, GitStatus } from '@shared/types'
import { useSessions } from '../../store/sessions'
import { useEditors } from '../../store/editors'
import { localFsApi, remoteFsApi, type FsApi } from '../../lib/fsapi'
import FileTree, { type FileTreeHandle, type Selection } from './FileTree'
import FileMutationDialog, { type FileMutationKind } from './FileMutationDialog'
import { useEscapeKey } from '../../lib/useEscapeKey'
import {
  IconLocal,
  IconRemote,
  IconRefresh,
  IconArrowUp,
  IconHome,
  IconFile,
  IconPlus,
  IconEdit,
  IconTrash,
  IconDiff,
  IconSearch,
  IconClose
} from '../common/Icons'

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
  // Live shell cwd (OSC 7); fall back to the one-shot launch directory so a
  // workspace restore / reconnect still points the explorer at the right place
  // before the first prompt reports OSC 7.
  const cwd = active?.cwd
  const startCwd = active?.startCwd
  const targetPath = cwd ?? startCwd
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
  // Bumped on every load / session switch so a slower earlier list cannot
  // overwrite a newer one (classic home-then-cwd race when switching tabs).
  const loadGen = useRef(0)
  const treeRef = useRef<FileTreeHandle>(null)
  // Git status for the currently shown directory. `null` means "not yet known"
  // (loading), a populated object with `isRepo: false` means "known to be a
  // non-repo". The state is per-session/per-path so navigating away clears it
  // and re-entering kicks off a fresh fetch.
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null)
  // Fuzzy search state — opened by pressing `/` while the tree is focused.
  const [search, setSearch] = useState<{ q: string; match: string | null } | null>(null)

  const load = useCallback(
    async (path?: string) => {
      if (!api) return
      const gen = ++loadGen.current
      setErr(null)
      try {
        const l = await api.list(path)
        // Stale response: a newer load (or session switch) already started.
        if (gen !== loadGen.current) return
        loadedPath.current = l.path
        setListing(l)
        setSel(null)
        setMultiSel(new Set())
      } catch (e) {
        if (gen !== loadGen.current) return
        setErr(String((e as Error).message || e))
      }
    },
    [api]
  )

  // When the active session changes, reset and load its shell directory (or home).
  // Prefer live cwd, then startCwd; only fall back to home when neither is known.
  useEffect(() => {
    loadGen.current++
    setListing(null)
    setSel(null)
    setMultiSel(new Set())
    loadedPath.current = null
    setGitStatus(null)
    if (api) {
      if (targetPath) load(targetPath)
      else load()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id])

  // Follow the shell: when cwd changes (and differs from what's shown), navigate.
  // Also re-run when startCwd is the only known path (e.g. just restored).
  useEffect(() => {
    if (!api || !targetPath) return
    if (targetPath !== loadedPath.current) load(targetPath)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetPath])

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
    const off = window.devterm.git.onChange(target, (s) => {
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

  const [dialog, setDialog] = useState<null | { kind: FileMutationKind }>(null)
  const [busy, setBusy] = useState(false)
  const [diffResult, setDiffResult] = useState<null | { file: string; patch: string }>(null)
  // The diff modal renders outside ModalShell — give it the same Esc-to-close.
  const closeDiff = useCallback(() => setDiffResult(null), [])
  useEscapeKey(closeDiff, diffResult !== null)

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
  const searchQuery = search?.q ?? null
  useEffect(() => {
    if (!searchQuery) return
    const hit = listing?.entries.find((e) => fuzzyMatch(e.name, searchQuery))
    setSearch((cur) => (cur ? { ...cur, match: hit ? hit.path : null } : cur))
  }, [searchQuery, listing?.entries, fuzzyMatch])

  const refreshDir = async (dir: string) => {
    if (listing && samePath(dir, listing.path)) await load(listing.path)
    else await treeRef.current?.openDir(dir)
  }

  const handleMutation = async (value: string) => {
    if (!dialog || !api || !listing) return
    setBusy(true)
    try {
      const name = value.trim()
      const { kind } = dialog
      if (kind === 'mkdir' && name) {
        await api.mkdir(childOf(createDir, name, sep))
        await refreshDir(createDir)
      } else if (kind === 'newfile' && name) {
        await api.createFile(childOf(createDir, name, sep))
        await refreshDir(createDir)
      } else if (kind === 'rename' && sel && name && name !== sel.name) {
        const parent = parentDir(sel.path)
        await api.rename(sel.path, childOf(parent, name, sep))
        setSel(null)
        await refreshDir(parent)
      } else if (kind === 'delete' && sel) {
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
    <div className="explorer" onKeyDown={onExplorerKey} tabIndex={0}>
      <div className="explorer-head">
        <span className="ex-kind">
          {kind === 'remote' ? <IconRemote size={14} /> : <IconLocal size={14} />}
          Files
        </span>
        <span className="spacer" />
        <button
          className="icon-btn"
          title="New file"
          onClick={() => setDialog({ kind: 'newfile' })}
        >
          <IconFile size={14} />
        </button>
        <button
          className="icon-btn"
          title="New folder"
          onClick={() => setDialog({ kind: 'mkdir' })}
        >
          <IconPlus size={14} />
        </button>
        <button
          className="icon-btn"
          title="Rename"
          disabled={!sel}
          onClick={() => sel && setDialog({ kind: 'rename' })}
        >
          <IconEdit size={14} />
        </button>
        <button
          className="icon-btn danger"
          title="Delete"
          disabled={!sel}
          onClick={() => sel && setDialog({ kind: 'delete' })}
        >
          <IconTrash size={14} />
        </button>
        <button
          className="icon-btn"
          title="Show changes"
          disabled={!sel || !gitStatus?.isRepo}
          onClick={async () => {
            if (!sel) return
            try {
              const patch = await requestDiff(sel)
              setDiffResult({ file: sel.name, patch: patch || '(no changes)' })
            } catch (e) {
              setErr(`diff failed: ${(e as Error).message}`)
            }
          }}
        >
          <IconDiff size={14} />
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
        {search && (
          <div className="explorer-search">
            <IconSearch size={12} />
            <input
              autoFocus
              value={search.q}
              placeholder="find file…"
              onChange={(e) => setSearch({ ...search, q: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault()
                  setSearch(null)
                } else if (e.key === 'Enter') {
                  e.preventDefault()
                  const match = listing?.entries.find((x) => x.path === search.match)
                  if (match) {
                    if (match.isDir) void treeRef.current?.openDir(match.path)
                    else {
                      setSel(match)
                      openEntryEditor(match)
                    }
                  }
                  setSearch(null)
                }
              }}
            />
            <span className="explorer-search-hint">{search.match ? '↵ to open' : 'no match'}</span>
            <button className="icon-btn" title="Close search" onClick={() => setSearch(null)}>
              <IconClose size={12} />
            </button>
          </div>
        )}
      </div>

      {dialog && (
        <FileMutationDialog
          kind={dialog.kind}
          targetName={sel?.name}
          targetPath={sel?.path}
          isTargetDir={sel?.isDir}
          busy={busy}
          onSubmit={handleMutation}
          onClose={() => !busy && setDialog(null)}
        />
      )}

      {diffResult && (
        <div className="modal-backdrop" onClick={() => setDiffResult(null)}>
          <div className="modal diff-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Changes — {diffResult.file}</h3>
            <pre className="diff-body">{diffResult.patch}</pre>
            <div className="actions">
              <button className="ghost" onClick={() => setDiffResult(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
