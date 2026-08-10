import { useEffect, useMemo, useRef, useState } from 'react'
import type { AgentKind, ConfirmRequest } from '@shared/types'
import { useSessions } from '../../store/sessions'

const SNOOZE_MS = 5 * 60 * 1000

const AGENT_DISPLAY: Record<AgentKind, string> = {
  devterm: 'DevTerm Agent',
  claude: 'Claude',
  pi: 'Pi',
  opencode: 'OpenCode',
  kimi: 'Kimi',
  grok: 'Grok',
  codex: 'Codex',
  antigravity: 'Antigravity'
}

function agentName(kind: AgentKind | undefined): string {
  return kind ? (AGENT_DISPLAY[kind] ?? 'The agent') : 'The agent'
}

/**
 * Human-in-the-loop approval queue for guarded agent actions (confirm mode
 * or a destructive op). Multiple requests can be in flight from one or more
 * agent sessions; we stack them FIFO and let the operator step through with
 * prev/next. Approving / denying / snoozing removes the request from the
 * visible queue; the next pending request becomes the new "1 of N".
 *
 * The confirm IPC path on the main side is also a queue of pending resolves
 * keyed by `reqId`; that side already supports multiple in flight. The modal
 * is the renderer's view of the same queue.
 */
export default function ConfirmActionModal() {
  const [queue, setQueue] = useState<ConfirmRequest[]>([])
  const [snoozed, setSnoozed] = useState<Map<string, number>>(new Map())
  const [now, setNow] = useState(Date.now())
  const [pointer, setPointer] = useState(0)
  const [remember, setRemember] = useState(false)
  const sessions = useSessions((s) => s.sessions)

  useEffect(() => {
    return window.devterm.agent.onConfirm((r) => {
      setQueue((q) => (q.some((x) => x.reqId === r.reqId) ? q : [...q, r]))
      // Flag the originating session so its tab dot can glow yellow until the
      // operator acts on the request. Cleared in the reply/snooze handlers.
      useSessions.getState().setAgentPendingApproval(r.sessionId, true)
    })
  }, [])

  // Another window may answer first (floating agent pop-out). Drop the request
  // so we don't leave a ghost modal or a stuck pending-approval badge.
  useEffect(() => {
    return window.devterm.agent.onConfirmResolved(({ reqId, sessionId }) => {
      setQueue((q) => {
        const next = q.filter((x) => x.reqId !== reqId)
        if (!next.some((x) => x.sessionId === sessionId)) {
          useSessions.getState().setAgentPendingApproval(sessionId, false)
        }
        return next
      })
      setSnoozed((s) => {
        if (!s.has(reqId)) return s
        const next = new Map(s)
        next.delete(reqId)
        return next
      })
    })
  }, [])

  // Re-evaluate snooze expiry every 10 seconds so snoozed requests resurface.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 10000)
    return () => clearInterval(t)
  }, [])

  const visible = useMemo(
    () => queue.filter((r) => (snoozed.get(r.reqId) ?? 0) <= now),
    [queue, snoozed, now]
  )
  // If the queue shrinks below the pointer (e.g. the top got approved), reset
  // the pointer so prev/next stays in bounds.
  const safeIndex = visible.length === 0 ? 0 : Math.min(pointer, visible.length - 1)
  const top = visible[safeIndex] ?? null
  const snoozedCount = queue.length - visible.length

  const modalRef = useRef<HTMLDivElement>(null)
  const denyRef = useRef<HTMLButtonElement>(null)

  // Keyboard operation: focus the safe default ("Deny") whenever a new request
  // surfaces; Left/Right then move focus between the buttons and Enter/Space
  // activate the focused one (native button behavior). Esc and overlay-click
  // stay disabled on purpose — approval must be an explicit choice.
  useEffect(() => {
    denyRef.current?.focus()
  }, [top?.reqId])

  const onModalKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    const buttons = Array.from(
      modalRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []
    )
    if (buttons.length === 0) return
    e.preventDefault()
    const idx = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const delta = e.key === 'ArrowRight' ? 1 : -1
    buttons[(idx + delta + buttons.length) % buttons.length]?.focus()
  }

  // When every pending request is snoozed, show a small floating indicator so
  // the operator doesn't lose track of blocked agent actions.
  if (!top) {
    if (snoozedCount === 0) return null
    return (
      <div className="confirm-snoozed-badge" title="Pending agent approvals are snoozed">
        <span>
          ⚠ {snoozedCount} pending approval{snoozedCount === 1 ? '' : 's'} snoozed
        </span>
        <button
          className="ghost small"
          onClick={() => {
            setSnoozed(new Map())
            setNow(Date.now())
          }}
        >
          Show now
        </button>
      </div>
    )
  }
  const idx = safeIndex + 1
  const total = visible.length

  const reply = (approved: boolean) => {
    window.devterm.agent.replyConfirm(top.reqId, approved)
    if (approved && remember) {
      const prefix = extractCommandPrefix(top.tool, top.detail)
      if (prefix) {
        // The longest-prefix match in approval-rules ensures specificity is
        // preserved; adding an allow rule for this prefix lets future calls
        // skip the prompt.
        void window.devterm.approvalRules
          .add({ commandPrefix: prefix, outcome: 'allow' })
          .catch(() => undefined)
      }
    }
    setQueue((q) => q.filter((x) => x.reqId !== top.reqId))
    setSnoozed((s) => {
      const next = new Map(s)
      next.delete(top.reqId)
      return next
    })
    // The session still has this id pending only if another queued request
    // targets it; otherwise the dot can go back to its normal color.
    if (!queue.some((x) => x.sessionId === top.sessionId && x.reqId !== top.reqId)) {
      useSessions.getState().setAgentPendingApproval(top.sessionId, false)
    }
    setRemember(false)
  }

  const snooze = () => {
    setSnoozed((s) => {
      const next = new Map(s)
      next.set(top.reqId, Date.now() + SNOOZE_MS)
      return next
    })
    // SNOOZE only hides the modal; the bridge still has the request open. Keep
    // the tab dot yellow so the operator knows action is still pending; the
    // flag will clear when the request is resolved via replyConfirm.
  }

  const session = sessions.find((x) => x.id === top.sessionId)
  const host = session?.context?.hostname || session?.title || top.sessionId
  const name = agentName(session?.agentKind)

  return (
    <div className="modal-backdrop">
      <div
        ref={modalRef}
        className="modal confirm-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-action-title"
        onKeyDown={onModalKeyDown}
      >
        <div className="confirm-head">
          <h3 id="confirm-action-title">⚠ Approve agent action?</h3>
          {total > 1 && (
            <div className="confirm-queue-meta">
              <button
                className="ghost small"
                disabled={safeIndex === 0}
                onClick={() => setPointer((p) => Math.max(0, p - 1))}
                title="Show the previous pending request"
              >
                ‹ Prev
              </button>
              <span className="confirm-counter">
                {idx} of {total}
              </span>
              <button
                className="ghost small"
                disabled={safeIndex >= total - 1}
                onClick={() => setPointer((p) => Math.min(total - 1, p + 1))}
                title="Show the next pending request"
              >
                Next ›
              </button>
            </div>
          )}
        </div>
        <p>
          {name} wants to run a guarded operation on{' '}
          <span className="confirm-host" title={`session ${top.sessionId}`}>
            {host}
          </span>
          :
        </p>
        <div className="confirm-tool">{top.tool}</div>
        <pre className="confirm-detail">{top.detail}</pre>
        <label className="confirm-remember">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
          />
          <span>Remember my choice (add an allow rule for the command prefix)</span>
        </label>
        <div className="actions">
          <button className="ghost" onClick={snooze} title="Hide this for 5 minutes">
            Snooze 5 min
          </button>
          <span className="spacer" />
          <button ref={denyRef} className="ghost" onClick={() => reply(false)}>
            Deny
          </button>
          <button className="danger" onClick={() => reply(true)}>
            Approve &amp; run
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * Build a stable command prefix for the "remember my choice" rule.
 *   1. For `run_command`, take the first 1–2 stable tokens (non-flag,
 *      non-shell-metachar). Path-like tokens (`./deploy.sh`, `bin/migrate`,
 *      `scripts/run`) are kept — losing the path was the bug this fix
 *      addresses. Cap at 80 chars.
 *   2. For `write_file`, the file path itself — the bytes + content vary
 *      per call, so the path is the only meaningful prefix.
 *   3. Fall back to the raw detail trimmed.
 *
 * Exported for unit tests in `extractCommandPrefix.test.ts`.
 */
export function extractCommandPrefix(tool: string, detail: string): string | undefined {
  const trimmed = detail.trim()
  if (!trimmed) return undefined
  if (tool === 'run_command') {
    const parts = trimmed.split(/\s+/).filter(Boolean)
    if (parts.length === 0) return undefined
    // Drop flag-looking parts (-x, --foo) and shell metacharacters so we
    // don't pin to a one-off flag or a redirect. Path separators (./, /, .)
    // are intentionally allowed so `./deploy.sh`, `bin/migrate`, and
    // `scripts/run` all produce a meaningful prefix.
    const stable = parts.filter((p) => !p.startsWith('-') && !/^[|;&<>(){}`$!]+$/.test(p))
    if (stable.length === 0) return parts[0]
    // Cap at 2 tokens so we don't anchor to one-off arguments (e.g. a hash
    // or a hostname). 80 chars protects against pathologically long tokens.
    return stable.slice(0, 2).join(' ').slice(0, 80)
  }
  if (tool === 'write_file') {
    return trimmed.replace(/\s*\(\d+\s+bytes\)\s*$/, '').trim() || undefined
  }
  return trimmed.slice(0, 80)
}

// Re-export the snooze duration so a future track can add a timer to
// re-surface snoozed requests.
export const CONFIRM_SNOOZE_MS = SNOOZE_MS
