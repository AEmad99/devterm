import type { Session } from '../store/sessions'
import { useEditors } from '../store/editors'

export interface CloseGuardInfo {
  /** True when closing would kill live work or lose unsaved changes. */
  needed: boolean
  /** Human-readable reasons, e.g. ['a running agent', 'unsaved changes']. */
  reasons: string[]
}

/** Unsaved editor documents owned by a session (or local docs when scope local). */
function dirtyEditorsFor(session: Session): number {
  return useEditors
    .getState()
    .docs.filter(
      (d) =>
        d.state === 'ready' &&
        d.content !== d.savedContent &&
        (d.scope === 'local' || d.sessionId === session.id)
    ).length
}

/**
 * Decide whether closing `session` deserves a confirmation. Kills a live agent
 * or a running process, or discards unsaved editor buffers.
 */
export function sessionCloseGuard(session: Session | undefined): CloseGuardInfo {
  if (!session) return { needed: false, reasons: [] }
  const reasons: string[] = []
  if (session.agentUiMode) reasons.push('a running agent')
  else if (session.processRunning) reasons.push('a running process')
  const dirty = dirtyEditorsFor(session)
  if (dirty > 0) reasons.push(dirty === 1 ? 'unsaved changes' : `${dirty} unsaved files`)
  return { needed: reasons.length > 0, reasons }
}

/** True when any editor document has unsaved changes (quit guard). */
export function hasUnsavedEditors(): boolean {
  return useEditors
    .getState()
    .docs.some((d) => d.state === 'ready' && d.content !== d.savedContent)
}
