import { useCallback, useEffect, useState } from 'react'
import type { PortForward, PortForwardKind } from '@shared/types'
import { formatBytes } from '../../lib/format'

interface Props {
  sessionId: string
}

export default function PortForwardPanel({ sessionId }: Props) {
  const [forwards, setForwards] = useState<PortForward[]>([])
  const [kind, setKind] = useState<PortForwardKind>('local')
  const [localPort, setLocalPort] = useState('')
  const [remoteHost, setRemoteHost] = useState('localhost')
  const [remotePort, setRemotePort] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setForwards(await window.devterm.portForward.list(sessionId))
    } catch (e) {
      console.error('portForward.list failed', e)
    }
  }, [sessionId])

  useEffect(() => {
    refresh()
    const id = setInterval(refresh, 2000)
    return () => clearInterval(id)
  }, [refresh])

  const add = async () => {
    setError(null)
    const lp = parseInt(localPort, 10)
    const rp = parseInt(remotePort, 10)
    if (!lp || lp < 1 || lp > 65535) {
      setError('Local port must be 1-65535')
      return
    }
    if (kind === 'local' && (!remoteHost || !rp || rp < 1 || rp > 65535)) {
      setError('Remote host and port are required for local forwards')
      return
    }
    setBusy(true)
    try {
      await window.devterm.portForward.add({
        sessionId,
        kind,
        localPort: lp,
        remoteHost: kind === 'local' ? remoteHost : undefined,
        remotePort: kind === 'local' ? rp : undefined
      })
      setLocalPort('')
      setRemotePort('')
      await refresh()
    } catch (e) {
      setError((e as Error).message || 'Failed to add forward')
    } finally {
      setBusy(false)
    }
  }

  const remove = async (id: string) => {
    try {
      await window.devterm.portForward.remove(id)
      await refresh()
    } catch (e) {
      setError((e as Error).message || 'Failed to remove forward')
    }
  }

  const formatBytesOpt = (n?: number) => (n == null ? '—' : formatBytes(n))

  return (
    <div className="port-forward-panel">
      <div className="pf-form">
        <select value={kind} onChange={(e) => setKind(e.target.value as PortForwardKind)}>
          <option value="local">Local (-L)</option>
          <option value="dynamic">Dynamic (-D)</option>
        </select>
        <input
          type="number"
          placeholder="Local port"
          value={localPort}
          onChange={(e) => setLocalPort(e.target.value)}
        />
        {kind === 'local' && (
          <>
            <input
              type="text"
              placeholder="Remote host"
              value={remoteHost}
              onChange={(e) => setRemoteHost(e.target.value)}
            />
            <input
              type="number"
              placeholder="Remote port"
              value={remotePort}
              onChange={(e) => setRemotePort(e.target.value)}
            />
          </>
        )}
        <button className="primary" onClick={() => void add()} disabled={busy}>
          {busy ? '…' : 'Add'}
        </button>
      </div>
      {error && <div className="pf-error">{error}</div>}
      {forwards.length === 0 ? (
        <div className="pf-empty">No active forwards.</div>
      ) : (
        <ul className="pf-list">
          {forwards.map((f) => (
            <li key={f.id} className="pf-row">
              <span className="pf-kind">{f.kind}</span>
              <span className="pf-local">127.0.0.1:{f.localPort}</span>
              {f.kind === 'local' && (
                <span className="pf-remote">
                  → {f.remoteHost}:{f.remotePort}
                </span>
              )}
              <span className="pf-bytes" title="Bytes proxied">
                {formatBytesOpt(f.bytes)}
              </span>
              <button className="ghost small" onClick={() => void remove(f.id)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
