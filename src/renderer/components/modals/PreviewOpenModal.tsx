import { useEffect, useState } from 'react'
import type { PortForward } from '@shared/types'
import ModalShell from '../common/ModalShell'
import Button from '../common/Button'
import { useSessions } from '../../store/sessions'
import {
  listForwardedLocalPorts,
  openPreviewPane,
  requestPortForwardPanel
} from '../../lib/preview'

export type PreviewOpenKind = 'localhost' | 'forward' | 'folder'

export default function PreviewOpenModal({
  open,
  kind,
  onClose,
  onFocusTerminals
}: {
  open: boolean
  kind: PreviewOpenKind
  onClose: () => void
  /** Bring the terminals view forward before opening the port-forward panel. */
  onFocusTerminals?: () => void
}) {
  const activeId = useSessions((s) => s.activeId)
  const sessions = useSessions((s) => s.sessions)
  const active = sessions.find((s) => s.id === activeId)
  const [port, setPort] = useState('5173')
  const [forwards, setForwards] = useState<PortForward[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open || kind !== 'forward' || !activeId || active?.kind !== 'remote') {
      setForwards([])
      return
    }
    void listForwardedLocalPorts(activeId).then(setForwards)
  }, [open, kind, activeId, active?.kind])

  const runLocalhost = async () => {
    const n = Number(port)
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      setError('Port must be 1–65535')
      return
    }
    setBusy(true)
    setError(null)
    const id = await openPreviewPane({
      kind: 'localhost',
      port: n,
      sourceSessionId: activeId ?? undefined
    })
    setBusy(false)
    if (id) onClose()
    else setError('Could not open preview')
  }

  const runForward = async (localPort: number) => {
    setBusy(true)
    const id = await openPreviewPane({
      kind: 'forward',
      port: localPort,
      sourceSessionId: activeId ?? undefined
    })
    setBusy(false)
    if (id) onClose()
  }

  const runFolder = async (folderPath?: string) => {
    const path =
      folderPath ||
      (active?.kind === 'local' ? active.cwd : undefined) ||
      (await window.devterm.dialog.chooseDirectory())
    if (!path) return
    setBusy(true)
    const id = await openPreviewPane({
      kind: 'folder',
      folderPath: path,
      sourceSessionId: activeId ?? undefined
    })
    setBusy(false)
    if (id) onClose()
  }

  const title =
    kind === 'localhost'
      ? 'Preview localhost port'
      : kind === 'forward'
        ? 'Preview forwarded port'
        : 'Preview this folder'

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          {kind === 'localhost' && (
            <Button variant="primary" disabled={busy} onClick={() => void runLocalhost()}>
              Open
            </Button>
          )}
          {kind === 'folder' && (
            <Button variant="primary" disabled={busy} onClick={() => void runFolder()}>
              Choose folder
            </Button>
          )}
        </>
      }
    >
      {kind === 'localhost' && (
        <label>
          Local port
          <input value={port} onChange={(e) => setPort(e.target.value)} placeholder="5173" />
        </label>
      )}
      {kind === 'forward' && (
        <div>
          {active?.kind !== 'remote' ? (
            <p className="modal-hint">Select a remote terminal that has a local (-L) forward.</p>
          ) : forwards.length === 0 ? (
            <div className="modal-hint">
              <p>No local forwards on this session yet.</p>
              <Button
                variant="primary"
                onClick={() => {
                  if (!activeId) return
                  onFocusTerminals?.()
                  requestPortForwardPanel(activeId)
                  onClose()
                }}
              >
                Open port forwards
              </Button>
            </div>
          ) : (
            <ul className="preview-forward-list">
              {forwards.map((f) => (
                <li key={f.id}>
                  <Button
                    disabled={busy}
                    onClick={() => void runForward(f.localPort)}
                  >{`127.0.0.1:${f.localPort} → ${f.remoteHost}:${f.remotePort}`}</Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {kind === 'folder' && (
        <p className="modal-hint">
          Serves files from a folder on this machine at 127.0.0.1. Remote apps use a forwarded port
          instead — nothing is installed on the host.
        </p>
      )}
      {error && <p className="modal-hint">{error}</p>}
    </ModalShell>
  )
}
