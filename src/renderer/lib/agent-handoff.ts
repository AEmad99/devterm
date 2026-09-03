import type { AgentDelegateRequest } from '@shared/types'
import { useSessions } from '../store/sessions'
import { DEFAULT_GROUP, allLeaves, useLayout } from '../store/layout'

function report(req: AgentDelegateRequest, ok: boolean, error?: string): void {
  window.devterm.agent.ackDelegate({
    requestId: req.requestId,
    sessionId: req.sessionId,
    ok,
    error
  })
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Route a main-process delegation request into a visible local renderer tab. */
function handleDelegateRequest(req: AgentDelegateRequest): void {
  let created = false
  try {
    const sessions = useSessions.getState()
    const caller = sessions.sessions.find((session) => session.id === req.sourceSessionId)
    if (!caller || caller.kind !== 'local') {
      throw new Error('The source session is no longer a local terminal.')
    }

    const groupId = caller.groupId ?? DEFAULT_GROUP
    const sessionId = sessions.addLocal({
      id: req.sessionId,
      cwd: req.cwd,
      groupId,
      title: req.title
    })
    created = true
    sessions.setAgentLaunch(sessionId, {
      prompt: req.prompt,
      model: req.model,
      effort: req.effort,
      requestId: req.requestId
    })

    const layout = useLayout.getState()
    let placed = layout.addTabToSessionLeaf(req.sourceSessionId, sessionId)
    if (!placed) {
      // Reconcile immediately when this event races App's normal effect. The
      // targeted helper then moves an already-reconciled id to the caller leaf.
      layout.sync(
        useSessions.getState().sessions.map((session) => ({
          id: session.id,
          groupId: session.groupId
        }))
      )
      placed = layout.addTabToSessionLeaf(req.sourceSessionId, sessionId)
    }
    if (!placed) {
      // Last resort: App's sync drops a prescribed id into its group's active
      // leaf, which is a working home even when the source leaf is gone
      // (closed group, restore race). A delegate must never die on placement —
      // the pane is what the source agent's receipt points at.
      layout.sync(
        useSessions.getState().sessions.map((session) => ({
          id: session.id,
          groupId: session.groupId
        }))
      )
      placed = useLayout
        .getState()
        .groups.some(
          (g) => g.root && allLeaves(g.root).some((leaf) => leaf.tabs.includes(sessionId))
        )
    }
    if (!placed) throw new Error('Could not place the delegated tab beside its source agent.')
    if (req.layout === 'split') {
      layout.splitBeside(req.sourceSessionId, sessionId, 'right')
    }

    // Set the mode only after the pane is in the layout, so AgentPane mounts
    // with the one-time launch payload ready to consume.
    sessions.setAgentUi(sessionId, { mode: 'docked', kind: req.kind })
    // Do NOT acknowledge success here: the definitive ack comes from AgentPane
    // after `agent.open` actually resolves, so the source agent learns about
    // real spawn failures instead of a premature success. Only placement
    // failures (below) report early — a mounted AgentPane always reports.
  } catch (error) {
    if (created) useSessions.getState().close(req.sessionId)
    report(req, false, messageOf(error))
  }
}

let wired = false

/** Subscribe once to main's local-agent delegation requests. */
export function initAgentHandoff(): void {
  if (wired) return
  wired = true
  window.devterm.agent.onDelegateRequest(handleDelegateRequest)
}
