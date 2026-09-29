import { useEffect, useRef, useState } from 'react'
import type { BrowserCertificatePrompt } from '@shared/types'
import ModalShell from '../common/ModalShell'
import Button from '../common/Button'
import ModalFooter from '../common/ModalFooter'

const CERT_ERROR_TEXT: Record<string, string> = {
  'net::ERR_CERT_AUTHORITY_INVALID': 'The signing authority is not trusted.',
  'net::ERR_CERT_COMMON_NAME_INVALID': 'The certificate is not valid for this address.',
  'net::ERR_CERT_DATE_INVALID': 'The certificate is expired or not yet valid.',
  'net::ERR_CERT_WEAK_SIGNATURE_ALGORITHM': 'The certificate uses a weak signature.',
  'net::ERR_CERT_INVALID': 'The certificate is invalid.',
  'net::ERR_CERT_REVOKED': 'The certificate has been revoked.',
  'net::ERR_CERT_CONTAINS_ERRORS': 'The certificate contains errors.',
  'net::ERR_CERT_UNABLE_TO_CHECK_REVOCATION': 'Revocation status could not be checked.',
  'net::ERR_CERT_NO_REVOCATION_MECHANISM': 'The certificate has no revocation mechanism.'
}

function formatWhen(seconds?: number): string {
  if (!seconds) return ''
  const date = new Date(seconds * 1000)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

/**
 * In-app replacement for the native certificate dialog. The prompt stays inside
 * DevTerm's window so a development or self-signed site does not raise a
 * Windows system message on top of the browser pane.
 */
export default function CertificatePrompt() {
  const [queue, setQueue] = useState<BrowserCertificatePrompt[]>([])
  const current = queue[0]
  const promptId = current?.id
  const backRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!promptId) return
    const timer = window.setTimeout(() => backRef.current?.focus(), 0)
    return () => window.clearTimeout(timer)
  }, [promptId])

  useEffect(() => {
    let alive = true
    const off = window.devterm.browser.onCertificatePrompt((prompt) => {
      setQueue((items) =>
        items.some((item) => item.id === prompt.id) ? items : [...items, prompt]
      )
    })
    void window.devterm.browser.pendingCertificates().then((pending) => {
      if (!alive) return
      setQueue((items) => {
        const ids = new Set(items.map((item) => item.id))
        return [...items, ...pending.filter((prompt) => !ids.has(prompt.id))]
      })
    })
    return () => {
      alive = false
      off()
    }
  }, [])

  const answer = (trust: boolean) => {
    if (!current) return
    const id = current.id
    window.devterm.browser.replyCertificate(id, trust)
    setQueue((items) => items.filter((item) => item.id !== id))
  }

  const validStart = formatWhen(current?.validStart)
  const validExpiry = formatWhen(current?.validExpiry)
  const validity =
    validStart && validExpiry ? `${validStart} – ${validExpiry}` : validExpiry || validStart

  return (
    <ModalShell
      open={!!current}
      onClose={() => answer(false)}
      title="Certificate warning"
      size="sm"
      className="cert-prompt"
      footer={
        <ModalFooter>
          <Button ref={backRef} variant="ghost" onClick={() => answer(false)}>
            Go back
          </Button>
          <Button variant="primary" onClick={() => answer(true)}>
            Trust and continue
          </Button>
        </ModalFooter>
      }
    >
      {current && (
        <>
          <p className="cert-lead">
            The certificate for <strong>{current.host}</strong> cannot be verified.
          </p>
          <p className="cert-reason">
            {CERT_ERROR_TEXT[current.error] ??
              'DevTerm cannot confirm this certificate is genuine.'}
          </p>
          <dl className="cert-facts">
            <dt>Address</dt>
            <dd>{current.host}</dd>
            <dt>Issued to</dt>
            <dd>{current.subjectName || current.host}</dd>
            <dt>Issued by</dt>
            <dd>{current.issuerName || 'Unknown issuer'}</dd>
            <dt>Fingerprint</dt>
            <dd>{current.fingerprint}</dd>
            {validity && (
              <>
                <dt>Valid</dt>
                <dd>{validity}</dd>
              </>
            )}
          </dl>
          <p className="cert-note">
            Continue only for a development or test server you trust. This exception lasts until
            DevTerm quits and applies only to the in-app browser.
          </p>
          <p className="cert-code">{current.error}</p>
        </>
      )}
    </ModalShell>
  )
}
