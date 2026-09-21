import { useSessions } from '../store/sessions'
import { useSettings } from '../store/settings'
import { toast } from '../store/toasts'
import { commentsForPrompt } from './command-blocks'
import { ensureAgent, injectAgentPrompt } from './agent-ui'
import {
  formatPreviewCommentsForAgent,
  formatSelectionForAgent,
  selectionOrigin
} from './agent-selection-format'
import type { PreviewAnnotation } from '@shared/types'

export {
  formatSelectionForAgent,
  MAX_SELECTION_CHARS,
  selectionOrigin,
  selectionWhere
} from './agent-selection-format'

function composePayload(
  sessionId: string,
  origin: ReturnType<typeof selectionOrigin>,
  selection: string
): string {
  const quote = formatSelectionForAgent(origin, selection)
  const comments = commentsForPrompt(sessionId)
  if (!comments) return quote
  return `${quote}\n\n${comments}`
}

/**
 * Ensure the pane agent is running, then inject the quoted selection.
 * Works for docked, hidden, and floating surfaces — writes go to the agent
 * PTY in main, which is broadcast to every window.
 */
export async function askAgentAboutSelection(opts: {
  sessionId: string
  selection: string
  source?: 'terminal' | 'editor'
}): Promise<boolean> {
  const selection = opts.selection.replace(/\s+$/u, '')
  if (!selection) {
    toast('Select text first, then Ask agent about this.', 'err')
    return false
  }
  const session = useSessions.getState().sessions.find((s) => s.id === opts.sessionId)
  if (!session || session.kind === 'browser') {
    toast('No terminal to send this selection from.', 'err')
    return false
  }
  const kind = session.agentKind ?? useSettings.getState().agentKind
  const uiMode = session.agentUiMode ?? 'docked'
  const payload = composePayload(session.id, selectionOrigin(session), selection)
  try {
    const result = await ensureAgent({
      sessionId: session.id,
      kind,
      cwd: session.cwd,
      uiMode,
      initialPrompt: session.agentUiMode ? undefined : payload
    })
    if (result.reused || result.promptDelivered !== true) {
      await injectAgentPrompt(session.id, result.ptyId, payload, { fresh: !result.reused })
    }
    toast('Sent selection to the agent.')
    return true
  } catch (err) {
    toast(err instanceof Error ? err.message : 'Could not send selection to the agent.', 'err')
    return false
  }
}

/** Send preview overlay comments (and optional screenshot path) to the source pane agent. */
export async function askAgentAboutPreview(opts: {
  sourceSessionId: string
  previewTitle: string
  url?: string
  comments: PreviewAnnotation[]
  screenshotPath?: string
}): Promise<boolean> {
  const session = useSessions.getState().sessions.find((s) => s.id === opts.sourceSessionId)
  if (!session || session.kind === 'browser') {
    toast('Open Preview from a terminal pane so comments have an agent to send to.', 'err')
    return false
  }
  const payload = formatPreviewCommentsForAgent({
    tabLabel: opts.previewTitle,
    url: opts.url,
    comments: opts.comments.map((c) => ({ kind: c.kind, body: c.body, x: c.x, y: c.y })),
    screenshotPath: opts.screenshotPath
  })
  const kind = session.agentKind ?? useSettings.getState().agentKind
  const uiMode = session.agentUiMode ?? 'docked'
  try {
    const result = await ensureAgent({
      sessionId: session.id,
      kind,
      cwd: session.cwd,
      uiMode,
      initialPrompt: session.agentUiMode ? undefined : payload
    })
    if (result.reused || result.promptDelivered !== true) {
      await injectAgentPrompt(session.id, result.ptyId, payload, { fresh: !result.reused })
    }
    toast('Sent preview comments to the agent.')
    return true
  } catch (err) {
    toast(err instanceof Error ? err.message : 'Could not send preview comments.', 'err')
    return false
  }
}
