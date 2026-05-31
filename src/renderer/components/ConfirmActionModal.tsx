import { useEffect, useState } from 'react'
import type { ConfirmRequest } from '@shared/types'

/**
 * Human-in-the-loop approval for guarded agent actions (confirm mode or a
 * destructive op). Listens globally for bridge confirm requests and replies.
 */
export default function ConfirmActionModal() {
  const [req, setReq] = useState<ConfirmRequest | null>(null)

  useEffect(() => window.devterm.claude.onConfirm((r) => setReq(r)), [])

  if (!req) return null
  const reply = (approved: boolean) => {
    window.devterm.claude.replyConfirm(req.reqId, approved)
    setReq(null)
  }

  return (
    <div className="modal-backdrop">
      <div className="modal confirm-modal">
        <h3>⚠ Approve agent action?</h3>
        <p>Claude wants to run a guarded operation on the remote host:</p>
        <div className="confirm-tool">{req.tool}</div>
        <pre className="confirm-detail">{req.detail}</pre>
        <div className="actions">
          <button className="ghost" onClick={() => reply(false)}>Deny</button>
          <button className="danger-btn" onClick={() => reply(true)}>Approve &amp; run</button>
        </div>
      </div>
    </div>
  )
}
