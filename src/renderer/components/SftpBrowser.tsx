import { useMemo, useRef, useState } from 'react'
import type { FileEntry } from '@shared/types'
import FilePane, { type FsApi } from './FilePane'
import TransferQueue, { type TransferItem } from './TransferQueue'
import Splitter from './Splitter'
import { useEditors } from '../store/editors'
import { useSessions } from '../store/sessions'

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))

/** Dual-pane local ↔ remote browser bound to one SSH session's SFTP channel. */
export default function SftpBrowser({ sessionId }: { sessionId: string }) {
  const localSep = window.devterm.platform === 'win32' ? '\\' : '/'

  const localApi = useMemo<FsApi>(
    () => ({
      list: (p) => window.devterm.fs.list(p),
      home: () => window.devterm.fs.home(),
      mkdir: (p) => window.devterm.fs.mkdir(p),
      rename: (a, b) => window.devterm.fs.rename(a, b),
      delete: (p) => window.devterm.fs.delete(p)
    }),
    []
  )
  const remoteApi = useMemo<FsApi>(
    () => ({
      list: (p) => window.devterm.sftp.list(sessionId, p),
      home: () => window.devterm.sftp.home(sessionId),
      mkdir: (p) => window.devterm.sftp.mkdir(sessionId, p),
      rename: (a, b) => window.devterm.sftp.rename(sessionId, a, b),
      delete: (p) => window.devterm.sftp.delete(sessionId, p)
    }),
    [sessionId]
  )

  const openEditor = useEditors((s) => s.open)
  // The remote shell's working directory (reported via OSC 7) so the remote pane
  // can follow `cd` in the terminal.
  const followCwd = useSessions((s) => s.sessions.find((x) => x.id === sessionId)?.cwd)
  const localCwd = useRef('')
  const remoteCwd = useRef('')
  const [localReload, setLocalReload] = useState(0)
  const [remoteReload, setRemoteReload] = useState(0)
  const [items, setItems] = useState<TransferItem[]>([])
  const [localWidth, setLocalWidth] = useState(420)

  const track = (
    id: string,
    direction: 'upload' | 'download',
    name: string,
    onLand: () => void
  ) => {
    setItems((prev) => [{ id, direction, name, transferred: 0, total: 0, done: false }, ...prev])
    const off = window.devterm.transfer.onProgress(id, (p) => {
      setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...p } : it)))
      if (p.done) {
        off()
        if (!p.error && !p.canceled) onLand()
      }
    })
  }

  const upload = async (entry: FileEntry) => {
    const remotePath = remoteCwd.current.replace(/\/$/, '') + '/' + entry.name
    const id = await window.devterm.transfer.start({
      direction: 'upload',
      sessionId,
      localPath: entry.path,
      remotePath
    })
    track(id, 'upload', entry.name, () => setRemoteReload((x) => x + 1))
  }

  const download = async (entry: FileEntry) => {
    const localPath = localCwd.current.replace(/[/\\]$/, '') + localSep + entry.name
    const id = await window.devterm.transfer.start({
      direction: 'download',
      sessionId,
      localPath,
      remotePath: entry.path
    })
    track(id, 'download', entry.name, () => setLocalReload((x) => x + 1))
  }

  return (
    <div className="sftp-browser">
      <div className="panes-row">
        <div className="pane-fixed" style={{ width: localWidth }}>
          <FilePane
            api={localApi}
            sep={localSep}
            title="💻 Local"
            transferLabel="Upload →"
            reloadSignal={localReload}
            onCwd={(p) => (localCwd.current = p)}
            onTransfer={upload}
            onEdit={(e) => openEditor({ scope: 'local', path: e.path })}
          />
        </div>
        <Splitter
          direction="horizontal"
          onDelta={(d) => setLocalWidth((w) => clamp(w + d, 240, 1000))}
        />
        <div className="pane-grow">
          <FilePane
            api={remoteApi}
            sep="/"
            title="🌐 Remote"
            transferLabel="← Download"
            reloadSignal={remoteReload}
            followPath={followCwd}
            onCwd={(p) => (remoteCwd.current = p)}
            onTransfer={download}
            onEdit={(e) => openEditor({ scope: 'remote', sessionId, path: e.path })}
          />
        </div>
      </div>
      <TransferQueue
        items={items}
        onCancel={(id) => window.devterm.transfer.cancel(id)}
        onClear={() => setItems((prev) => prev.filter((i) => !i.done))}
      />
    </div>
  )
}
