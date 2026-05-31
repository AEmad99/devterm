import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DirListing } from '@shared/types'
import { useSessions } from '../store/sessions'
import { useEditors } from '../store/editors'
import { localFsApi, remoteFsApi } from '../lib/fsapi'
import type { FsApi } from './FilePane'
import {
  IconLocal,
  IconRemote,
  IconRefresh,
  IconArrowUp,
  IconHome,
  IconFolder,
  IconFile,
  IconLink
} from './Icons'

/**
 * Persistent left side-panel file explorer for the active session. It follows
 * the shell's working directory (reported via OSC 7 into the session store) and
 * also supports manual navigation + refresh. Local sessions browse the local
 * filesystem; remote sessions browse over SFTP.
 */
export default function FileExplorer() {
  const active = useSessions((s) => s.sessions.find((x) => x.id === s.activeId))
  const kind = active?.kind
  const cwd = active?.cwd
  const isPending = !active || active.id.startsWith('pending-')
  // Browser panes have no filesystem; the explorer shows a placeholder for them.
  const isBrowser = active?.kind === 'browser'

  const api = useMemo<FsApi | null>(() => {
    if (isPending || !active || active.kind === 'browser') return null
    return active.kind === 'remote' ? remoteFsApi(active.id) : localFsApi()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id, kind, isPending])

  const openEditor = useEditors((s) => s.open)
  const [listing, setListing] = useState<DirListing | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [pathInput, setPathInput] = useState('')
  const loadedPath = useRef<string | null>(null)

  const load = useCallback(
    async (path?: string) => {
      if (!api) return
      setErr(null)
      try {
        const l = await api.list(path)
        loadedPath.current = l.path
        setListing(l)
      } catch (e) {
        setErr(String((e as Error).message || e))
      }
    },
    [api]
  )

  // When the active session changes, reset and load its cwd (or home).
  useEffect(() => {
    setListing(null)
    loadedPath.current = null
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
      <div className="explorer-list">
        {listing?.entries.map((e) => (
          <div
            key={e.path}
            className="ex-row"
            title={`${e.mode}  ${e.isDir ? '' : e.size + ' B'}`}
            onDoubleClick={() =>
              e.isDir
                ? load(e.path)
                : !e.isSymlink &&
                  active &&
                  openEditor({
                    scope: active.kind === 'remote' ? 'remote' : 'local',
                    sessionId: active.kind === 'remote' ? active.id : undefined,
                    path: e.path
                  })
            }
          >
            <span className={`ex-icon ${e.isDir ? 'is-dir' : ''}`}>
              {e.isDir ? (
                <IconFolder size={15} />
              ) : e.isSymlink ? (
                <IconLink size={15} />
              ) : (
                <IconFile size={15} />
              )}
            </span>
            <span className="ex-name">{e.name}</span>
          </div>
        ))}
        {listing && listing.entries.length === 0 && <div className="explorer-empty">(empty)</div>}
        {!listing && !err && <div className="explorer-empty">loading…</div>}
      </div>
    </div>
  )
}
