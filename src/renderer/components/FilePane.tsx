import { useCallback, useEffect, useRef, useState } from 'react'
import type { DirListing, FileEntry } from '@shared/types'
import { IconArrowUp, IconHome, IconPlus, IconEdit, IconFolder, IconFile, IconLink } from './Icons'

export interface FsApi {
  list(path?: string): Promise<DirListing>
  home(): Promise<string>
  mkdir(path: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  delete(path: string): Promise<void>
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`
  const u = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(1)} ${u[i]}`
}

export default function FilePane({
  api,
  sep,
  title,
  transferLabel,
  reloadSignal,
  followPath,
  onCwd,
  onTransfer,
  onEdit
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
  onEdit?: (entry: FileEntry) => void
}) {
  const [listing, setListing] = useState<DirListing | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [pathInput, setPathInput] = useState('')
  // Tracks the directory actually shown, so follow/edit effects don't loop.
  const currentPath = useRef<string | null>(null)

  const load = useCallback(
    async (path?: string) => {
      setErr(null)
      try {
        const l = await api.list(path)
        currentPath.current = l.path
        setListing(l)
        setSelected(null)
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

  const child = (name: string) => (listing ? listing.path.replace(/[/\\]$/, '') + sep + name : name)
  const sel = listing?.entries.find((e) => e.name === selected) || null

  // In-app dialogs — Electron does not implement window.prompt(), and
  // alert/confirm are unreliable under sandbox, so we use our own modal.
  const [dialog, setDialog] = useState<null | {
    kind: 'mkdir' | 'rename' | 'delete'
    value: string
  }>(null)
  const [busy, setBusy] = useState(false)

  const submitDialog = async () => {
    if (!dialog || !listing) return
    setBusy(true)
    try {
      if (dialog.kind === 'mkdir') {
        if (dialog.value.trim()) await api.mkdir(child(dialog.value.trim()))
      } else if (dialog.kind === 'rename' && sel) {
        if (dialog.value.trim() && dialog.value !== sel.name)
          await api.rename(sel.path, child(dialog.value.trim()))
      } else if (dialog.kind === 'delete' && sel) {
        await api.delete(sel.path)
      }
      setDialog(null)
      await load(listing.path)
    } catch (e) {
      setErr(`${dialog.kind} failed: ${(e as Error).message}`)
      setDialog(null)
    } finally {
      setBusy(false)
    }
  }

  const doMkdir = () => setDialog({ kind: 'mkdir', value: '' })
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
        <button className="btn-row" onClick={doMkdir}>
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
          disabled={!sel || sel.isDir}
          onClick={() => sel && onTransfer(sel)}
          className="primary"
        >
          {transferLabel}
        </button>
      </div>
      {err && <div className="fp-error">{err}</div>}
      <div className="filelist">
        <div className="filerow header">
          <span className="col-name">Name</span>
          <span className="col-size">Size</span>
          <span className="col-mode">Perms</span>
        </div>
        {listing?.entries.map((e) => (
          <div
            key={e.path}
            className={`filerow ${selected === e.name ? 'sel' : ''}`}
            onClick={() => setSelected(e.name)}
            onDoubleClick={() => (e.isDir ? load(e.path) : onTransfer(e))}
          >
            <span className="col-name">
              <span className={`file-ico ${e.isDir ? 'is-dir' : ''}`}>
                {e.isDir ? (
                  <IconFolder size={14} />
                ) : e.isSymlink ? (
                  <IconLink size={14} />
                ) : (
                  <IconFile size={14} />
                )}
              </span>
              {e.name}
            </span>
            <span className="col-size">{e.isDir ? '' : fmtSize(e.size)}</span>
            <span className="col-mode">{e.mode}</span>
          </div>
        ))}
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
                <h3>{dialog.kind === 'mkdir' ? 'New folder' : 'Rename'}</h3>
                <label>
                  {dialog.kind === 'mkdir' ? 'Folder name' : 'New name'}
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
                    {dialog.kind === 'mkdir' ? 'Create' : 'Rename'}
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
