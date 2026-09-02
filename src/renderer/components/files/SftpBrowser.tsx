import { useCallback, useMemo, useRef, useState } from 'react'
import type { FileEntry } from '@shared/types'
import FilePane from './FilePane'
import Splitter from '../common/Splitter'
import { localFsApi, remoteFsApi, type FsApi } from '../../lib/fsapi'
import { useEditors } from '../../store/editors'
import { useSessions } from '../../store/sessions'

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))
const MIN_PANE_FRAC = 0.28

/**
 * Dual-pane local ↔ remote browser bound to one SSH session's SFTP channel.
 * Uses the persistent transfer queue (see `useTransfersSync` mounted at the
 * App level) with multi-select + drag-and-drop transfers. Each file in the
 * multi-selection becomes one `TransferItemV2` enqueued through
 * `window.devterm.transfers.*`.
 */
export default function SftpBrowser({ sessionId }: { sessionId: string }) {
  const localSep = window.devterm.platform === 'win32' ? '\\' : '/'

  const localApi = useMemo<FsApi>(() => localFsApi(), [])
  const remoteApi = useMemo<FsApi>(() => remoteFsApi(sessionId), [sessionId])

  const openEditor = useEditors((s) => s.open)
  // The remote shell's working directory (reported via OSC 7) so the remote pane
  // can follow `cd` in the terminal.
  const followCwd = useSessions((s) => s.sessions.find((x) => x.id === sessionId)?.cwd)
  const localCwd = useRef('')
  const remoteCwd = useRef('')
  const rowRef = useRef<HTMLDivElement>(null)
  // Share the row 50/50 so a narrow dock (side pane ~420px) still shows both
  // machines. A pixel width on the local column used to eat the whole dock.
  const [localFrac, setLocalFrac] = useState(0.5)

  const onSplit = useCallback((deltaPx: number) => {
    const total = rowRef.current?.clientWidth ?? 0
    if (total <= 0) return
    setLocalFrac((f) => clamp(f + deltaPx / total, MIN_PANE_FRAC, 1 - MIN_PANE_FRAC))
  }, [])

  /**
   * Join a directory and a child name using the pane's separator. The
   * drop handler uses this to resolve a dragged path into the target
   * pane's destination.
   */
  const joinPath = (dir: string, name: string, sep: string) => {
    const stripped = dir.replace(/[/\\]+$/, '')
    return stripped + sep + name
  }

  /**
   * Enqueue a single upload from the LOCAL pane to the REMOTE cwd. The
   * `localPath` is on the host filesystem; the queue puts it at
   * `remoteCwd/<basename>` on the SSH server.
   */
  const enqueueOneUpload = async (entry: FileEntry) => {
    const remotePath = joinPath(remoteCwd.current, entry.name, '/')
    await window.devterm.transfers.enqueueUpload({
      sessionId,
      localPath: entry.path,
      remotePath
    })
  }

  const enqueueOneDownload = async (entry: FileEntry) => {
    const localPath = joinPath(localCwd.current, entry.name, localSep)
    await window.devterm.transfers.enqueueDownload({
      sessionId,
      localPath,
      remotePath: entry.path
    })
  }

  /**
   * Batch: the LOCAL pane's "Upload N" button calls this with the user's
   * full selection. Each file becomes one persistent queue item.
   */
  const uploadMany = (entries: FileEntry[]) => {
    for (const e of entries) {
      // Skip folders — uploads of directories are out of scope for v1
      // (SFTP supports them, but the existing streaming code is per-file).
      if (e.isDir) continue
      void enqueueOneUpload(e)
    }
  }
  const downloadMany = (entries: FileEntry[]) => {
    for (const e of entries) {
      if (e.isDir) continue
      void enqueueOneDownload(e)
    }
  }

  /**
   * Drop handler. A drag from the LOCAL pane to the REMOTE pane is an
   * upload; a drag from REMOTE to LOCAL is a download. We only know the
   * dragged absolute path + name + isDir — the drop side picks the
   * direction. The target pane is whichever fires this callback.
   */
  const onLocalDrop = (droppedPath: string, droppedName: string, isDir: boolean) => {
    if (isDir) return
    const localPath = joinPath(localCwd.current, droppedName, localSep)
    void window.devterm.transfers.enqueueDownload({
      sessionId,
      localPath,
      remotePath: droppedPath
    })
  }
  const onRemoteDrop = (droppedPath: string, droppedName: string, isDir: boolean) => {
    if (isDir) return
    const remotePath = joinPath(remoteCwd.current, droppedName, '/')
    void window.devterm.transfers.enqueueUpload({
      sessionId,
      localPath: droppedPath,
      remotePath
    })
  }

  return (
    <div className="sftp-browser">
      <div className="panes-row" ref={rowRef}>
        <div className="sftp-col" style={{ flex: `${localFrac} 1 0` }}>
          <FilePane
            api={localApi}
            sep={localSep}
            title="💻 Local"
            transferLabel="Upload →"
            reloadSignal={0}
            onCwd={(p) => (localCwd.current = p)}
            onTransfer={enqueueOneUpload}
            onTransferMany={uploadMany}
            onDropPath={onLocalDrop}
            onEdit={(e) => openEditor({ scope: 'local', path: e.path })}
          />
        </div>
        <Splitter direction="horizontal" onDelta={onSplit} />
        <div className="sftp-col" style={{ flex: `${1 - localFrac} 1 0` }}>
          <FilePane
            api={remoteApi}
            sep="/"
            title="🌐 Remote"
            transferLabel="← Download"
            reloadSignal={0}
            followPath={followCwd}
            onCwd={(p) => (remoteCwd.current = p)}
            onTransfer={enqueueOneDownload}
            onTransferMany={downloadMany}
            onDropPath={onRemoteDrop}
            onEdit={(e) => openEditor({ scope: 'remote', sessionId, path: e.path })}
          />
        </div>
      </div>
    </div>
  )
}
