import { useSessions, type Session } from '../../store/sessions'
import { useSettings } from '../../store/settings'
import { deriveTabStatus, type TabStatus } from '../../lib/tab-status'

/**
 * Tab dot for a single session. Renders the existing kind dot (local / remote
 * / browser) and overlays the derived per-session status. Status uses CSS
 * variables (`--tab-status-warn` / `--tab-status-error` / `--tab-status-pending`)
 * so themes can retint without code changes.
 *
 * Subscribes to the session record directly (selector form) so unrelated
 * session-store changes don't re-render every tab dot in the tree.
 */
export default function TabStatusDot({ sessionId }: { sessionId: string }) {
  // Selector form so this component only re-renders when the session record
  // changes; the rest of useSessions is irrelevant.
  const session = useSessions((s) => s.sessions.find((x) => x.id === sessionId) ?? null)
  const activityIndicators = useSettings((s) => s.activityIndicators)
  return <Dot session={session} activityIndicators={activityIndicators} />
}

function Dot({
  session,
  activityIndicators
}: {
  session: Session | null
  activityIndicators: boolean
}) {
  if (!session) {
    // The session has been removed from the store but the chrome still has a
    // reference; render a neutral dot rather than crashing the tab strip.
    return <span className="dot" data-kind="unknown" />
  }
  const input: Session = activityIndicators
    ? session
    : { ...session, processRunning: false, hasUnreadOutput: false }
  const status: TabStatus = deriveTabStatus(input)
  return (
    <span
      className="dot"
      data-kind={session.kind}
      data-status={status.tone}
      title={status.reason ?? session.title}
    />
  )
}
