import { useEffect, useState } from 'react'
import ModalShell from '../common/ModalShell'
import Button from '../common/Button'

interface KnownHost {
  hostId: string
  fingerprint: string
}

/**
 * Lists SSH known hosts (the trust-on-first-use store) and lets the operator
 * forget a host. Forgetting a host means the next connect re-triggers the
 * `hostkey-new` status so the operator can re-accept the key (useful when a
 * host was legitimately re-provisioned and now presents a new fingerprint).
 */
export default function KnownHostsModal({ onClose }: { onClose: () => void }) {
  const [hosts, setHosts] = useState<KnownHost[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)

  const refresh = () => {
    window.devterm.knownHosts
      .list()
      .then(setHosts)
      .catch((e) => setError((e as Error).message || 'Failed to load known hosts'))
  }

  useEffect(() => {
    refresh()
  }, [])

  const forget = async (hostId: string) => {
    setBusy(hostId)
    setError(null)
    try {
      await window.devterm.knownHosts.remove(hostId)
      setHosts((cur) => cur.filter((h) => h.hostId !== hostId))
    } catch (e) {
      setError(`Remove failed: ${(e as Error).message || String(e)}`)
    } finally {
      setBusy(null)
      setConfirmRemove(null)
    }
  }

  return (
    <ModalShell
      open
      onClose={onClose}
      title="Known SSH hosts"
      footer={<Button onClick={onClose}>Close</Button>}
    >
      <div className="kh-hint">
        Hosts DevTerm has trusted on first connect. Forgetting a host means the
        next connection will re-prompt for the key (useful when a host was
        legitimately re-provisioned).
      </div>

      {error && <div className="settings-error">{error}</div>}

      {hosts.length === 0 ? (
        <div className="settings-empty">No trusted hosts yet.</div>
      ) : (
        <ul className="kh-list">
          {hosts.map((h) => (
            <li key={h.hostId} className="kh-row">
              <div className="kh-host">{h.hostId}</div>
              <code className="kh-fp">{h.fingerprint}</code>
              {confirmRemove === h.hostId ? (
                <span className="kh-confirm">
                  Forget this host?
                  <Button
                    variant="danger"
                    onClick={() => void forget(h.hostId)}
                    disabled={busy === h.hostId}
                  >
                    {busy === h.hostId ? 'Forgetting…' : 'Yes, forget'}
                  </Button>
                  <Button onClick={() => setConfirmRemove(null)}>Cancel</Button>
                </span>
              ) : (
                <Button variant="danger" onClick={() => setConfirmRemove(h.hostId)}>
                  Forget
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </ModalShell>
  )
}
