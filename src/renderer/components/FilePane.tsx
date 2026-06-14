import { useCallback, useEffect, useRef, useState } from 'react'
import type { DirListing, FileEntry } from '@shared/types'
import type { FsApi } from '../lib/fsapi'
import FileTree, { type FileTreeHandle, type Selection } from './FileTree'
import { IconArrowUp, IconHome, IconPlus, IconFile, IconEdit } from './Icons'

// Re-exported for existing importers (e.g. SftpBrowser).
export type { FsApi } from '../lib/fsapi'
export type { Selection } from './FileTree'

/** Strip a trailing path separator. */
const strip = (p: string) => p.replace(/[/\\]+$/, '')
/** Join a directory and a child name with the pane's separator. */
const childOf = (dir: string, name: string, sep: string) => strip(dir) + sep + name
/** Parent directory of a path (handles both separators and the posix root). */
function parentDir(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  if (i > 0) return p.slice(0, i)
  if (i === 0) return p.slice(0, 1)
  return strip(p)
}
const samePath = (a: string, b: string) => strip(a) === strip(b)

export default function FilePane({
  api,
  sep,
  title,
  transferLabel,
  reloadSignal,
  followPath,
  onCwd,
  onTransfer,
  onTransferMany,
  onEdit,
  onDropPath
}: {
  api: FsApi
  sep: string
  title: string
  transferLabel: string
  reloadSignal: number
  /** When provided, the pane navigates here whenever it changes (e.g. shell cwd). */
  followPath?: string
  onCwd: (path: string) => void
  onTransfer: (entry: FileEntry) => void
  /**
   * Optional batch transfer hook. When provided, the per-row "Upload →" /
   * "← Download" button is replaced with a primary button that operates
   * on the full multi-selection (Upload N / Download N). When only a
   * single file is selected it falls back to `onTransfer`.
   */
  onTransferMany?: (entries: FileEntry[]) => void
  onEdit?: (entry: FileEntry) => void
  /**
   * Optional drop hook. The pane fires this when a `application/x-devterm-path`
   * item is dropped onto the file list. The parent decides the direction
   * (upload vs download) and enqueues a transfer.
   */
  onDropPath?: (droppedPath: string, droppedName: string, isDir: boolean) => void
}) {
  const [listing, setListing] = useState<DirListing | null>(null)
  const [sel, setSel] = useState<FileEntry | null>(null)
  const [multiSel, setMultiSel] = useState<Selection>(new Set())
  const [dropActive, setDropActive] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [pathInput, setPathInput] = useState('')
  // Tracks the directory actually shown, so follow/edit effects don't loop.
  const currentPath = useRef<string | null>(null)
  const treeRef = useRef<FileTreeHandle>(null)

  const load = useCallback(
    async (path?: string) => {
      setErr(null)
      try {
        const l = await api.list(path)
        currentPath.current = l.path
        setListing(l)
        setSel(null)
        setMultiSel(new Set())
        onCwd(l.path)
      } catch (e) {
        setErr(String((e as Error).message || e))
      }
    },
    [api, onCwd]
  )

  useEffect(() => {
    api.home().then((h) => load(h))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Keep the editable path box in sync with the directory being shown.
  useEffect(() => {
    if (listing) setPathInput(listing.path)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listing?.path])

  // Follow an external directory (the shell's cwd via OSC 7) when it changes.
  useEffect(() => {
    if (followPath && followPath !== currentPath.current) load(followPath)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [followPath])

  // External reload trigger (after a transfer lands here).
  useEffect(() => {
    if (reloadSignal > 0 && listing) load(listing.path)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadSignal])

  // Live updates: reflect any create / modify / delete / rename in the shown
  // directory without a manual refresh. Main pushes a fresh listing only on a
  // real content change; we swap it in place — keeping the selection if it still
  // exists — so navigation and selection aren't disturbed.
  useEffect(() => {
    const path = listing?.path
    if (!path) return
    const off = api.watch(path, (fresh) => {
      if (!samePath(fresh.path, currentPath.current ?? '')) return
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

  // New files/folders are created inside the selected folder when one is picked,
  // otherwise in the directory currently shown as the tree root.
  const createDir = sel?.isDir ? sel.path : (listing?.path ?? '')

  // In-app dialogs — Electron does not implement window.prompt(), and
  // alert/confirm are unreliable under sandbox, so we use our own modal.
  const [dialog, setDialog] = useState<null | {
    kind: 'mkdir' | 'newfile' | 'rename' | 'delete'
    value: string
  }>(null)
  const [busy, setBusy] = useState(false)

  // After a mutation, refresh the affected directory: the root via load(), a
  // nested directory via the tree's imperative reload (expanding it to reveal a
  // freshly created child).
  const refreshDir = async (dir: string) => {
    if (listing && samePath(dir, listing.path)) await load(listing.path)
    else await treeRef.current?.openDir(dir)
  }

  const submitDialog = async () => {
    if (!dialog || !listing) return
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

  const doMkdir = () => setDialog({ kind: 'mkdir', value: '' })
  const doNewFile = () => setDialog({ kind: 'newfile', value: '' })
  const doRename = () => sel && setDialog({ kind: 'rename', value: sel.name })
  const doDelete = () => sel && setDialog({ kind: 'delete', value: sel.name })

  return (
    <div className="filepane">
      <div className="filepane-head">
        <span className="fp-title">{title}</span>
        <form
          className="fp-pathform"
          onSubmit={(e) => {
            e.preventDefault()
            const p = pathInput.trim()
            if (p) load(p)
          }}
        >
          <input
            className="fp-pathinput"
            value={pathInput}
            spellCheck={false}
            placeholder="Type a path, press Enter…"
            title="Type a path and press Enter to jump there"
            onChange={(e) => setPathInput(e.target.value)}
          />
        </form>
      </div>
      <div className="filepane-toolbar">
        <button
          className="btn-row"
          disabled={!listing?.parent}
          onClick={() => listing?.parent && load(listing.parent)}
        >
          <IconArrowUp size={13} />
          Up
        </button>
        <button className="btn-row" onClick={() => api.home().then(load)}>
          <IconHome size={13} />
          Home
        </button>
        <button className="btn-row" onClick={doNewFile} title={`New file in ${createDir || '…'}`}>
          <IconFile size={13} />
          File
        </button>
        <button className="btn-row" onClick={doMkdir} title={`New folder in ${createDir || '…'}`}>
          <IconPlus size={13} />
          Folder
        </button>
        <button className="btn-row" disabled={!sel} onClick={doRename}>
          Rename
        </button>
        <button className="btn-row danger" disabled={!sel} onClick={doDelete}>
          Delete
        </button>
        {onEdit && (
          <button
            className="btn-row"
            disabled={!sel || sel.isDir || sel.isSymlink}
            onClick={() => sel && onEdit(sel)}
          >
            <IconEdit size={13} />
            Edit
          </button>
        )}
        <span className="spacer" />
        <button
          disabled={!sel || (sel.isDir && !onTransferMany)}
          onClick={() => {
            if (onTransferMany) {
              const items = collectSelected(listing, sel, multiSel)
              onTransferMany(items)
            } else if (sel) {
              onTransfer(sel)
            }
          }}
          className="primary"
          title={
            onTransferMany && multiSel.size > 1
              ? `Transfer ${multiSel.size} selected items`
              : 'Transfer the selected item'
          }
        >
          {onTransferMany && multiSel.size > 1
            ? `${transferLabel} ${multiSel.size}`
            : transferLabel}
        </button>
      </div>
      {err && <div className="fp-error">{err}</div>}
      <div
        className={`filelist ${dropActive ? 'drop-target' : ''}`}
        onDragOver={(e) => {
          if (!onDropPath) return
          if (e.dataTransfer.types.includes('application/x-devterm-path')) {
            e.preventDefault()
            e.dataTransfer.dropEffect = 'copy'
            if (!dropActive) setDropActive(true)
          }
        }}
        onDragLeave={() => setDropActive(false)}
        onDrop={(e) => {
          if (!onDropPath) return
          const dropped = e.dataTransfer.getData('application/x-devterm-path')
          if (!dropped) return
          e.preventDefault()
          setDropActive(false)
          const name = e.dataTransfer.getData('application/x-devterm-name') || basename(dropped)
          const isDir = e.dataTransfer.getData('application/x-devterm-isdir') === '1'
          onDropPath(dropped, name, isDir)
        }}
      >
        {listing && (
          <FileTree
            ref={treeRef}
            api={api}
            rootPath={listing.path}
            rootEntries={listing.entries}
            selectedPath={sel?.path ?? null}
            selectedPaths={multiSel}
            onSelect={setSel}
            onMultiSelect={setMultiSel}
            onActivateFile={onTransfer}
            onActivateDir={(e) => load(e.path)}
          />
        )}
        {listing && listing.entries.length === 0 && <div className="fp-empty">(empty)</div>}
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

/**
 * Resolve the user's "what to transfer" set. Order: explicit multi-selection
 * wins; if the user clicked only one entry we fall back to that single
 * entry. Hidden when there's neither (returns []).
 */
function collectSelected(
  listing: DirListing | null,
  sel: FileEntry | null,
  multiSel: Selection
): FileEntry[] {
  if (!listing) return []
  if (multiSel.size > 0) {
    return listing.entries.filter((e) => multiSel.has(e.path))
  }
  return sel ? [sel] : []
}

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i >= 0 ? p.slice(i + 1) : p
}
