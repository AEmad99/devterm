import type { Session } from '../store/sessions'

export const DEFAULT_HIBERNATE_AFTER_MS = 30_000
export const MIN_HIBERNATE_AFTER_MS = 1_000
export const MAX_HIBERNATE_AFTER_MS = 24 * 60 * 60 * 1000
export const DEFAULT_OUTPUT_RING_LINES = 10_000
export const MIN_OUTPUT_RING_LINES = 100
export const MAX_OUTPUT_RING_LINES = 100_000

export function normalizeHibernateAfterMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_HIBERNATE_AFTER_MS
  return Math.max(MIN_HIBERNATE_AFTER_MS, Math.min(MAX_HIBERNATE_AFTER_MS, Math.floor(value)))
}

export function normalizeOutputRingLines(value: unknown, fallback = DEFAULT_OUTPUT_RING_LINES): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.max(MIN_OUTPUT_RING_LINES, Math.min(MAX_OUTPUT_RING_LINES, Math.floor(value)))
}

/** True only for a terminal that is safe to hibernate right now. */
export function canHibernateSession(
  session: Pick<Session, 'kind' | 'groupId' | 'needsAttention' | 'agentPendingApproval'>,
  activeGroupId: string,
  dirtyEditor: boolean
): boolean {
  if (session.kind !== 'local' && session.kind !== 'remote') return false
  if ((session.groupId || 'default') === activeGroupId) return false
  if (session.needsAttention || session.agentPendingApproval) return false
  if (dirtyEditor) return false
  return true
}
