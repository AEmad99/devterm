import type { Session } from '../store/sessions'
import { deriveTabLabel } from './tab-label'

export const MAX_SELECTION_CHARS = 24_000

export interface SelectionOrigin {
  tabLabel: string
  where: string
  cwd?: string
}

/** `local` or `user@host` (falling back to hostname) for the quote header. */
export function selectionWhere(session: Pick<Session, 'kind' | 'title' | 'context'>): string {
  if (session.kind === 'local') return 'local'
  const title = (session.title ?? '').trim()
  const userHost = title.split(/\s+/)[0]
  if (userHost.includes('@')) return userHost
  if (session.context?.hostname) return session.context.hostname
  return 'remote'
}

export function selectionOrigin(session: Session): SelectionOrigin {
  return {
    tabLabel: deriveTabLabel(session).title,
    where: selectionWhere(session),
    cwd: session.cwd
  }
}

/**
 * Quote a terminal or editor selection for the agent PTY. The payload is
 * context only — no "fix this" instruction — so the operator can follow up.
 */
export function formatSelectionForAgent(origin: SelectionOrigin, selection: string): string {
  const raw = selection.replace(/\s+$/u, '')
  if (!raw) return ''
  const clipped =
    raw.length > MAX_SELECTION_CHARS ? `${raw.slice(0, MAX_SELECTION_CHARS)}\n… (truncated)` : raw
  const cwd = origin.cwd?.trim() ? origin.cwd : 'unknown cwd'
  return [
    `Operator selection from ${origin.tabLabel} (${origin.where}, ${cwd})`,
    '----',
    clipped,
    '----'
  ].join('\n')
}

export function formatPreviewCommentsForAgent(opts: {
  tabLabel: string
  url?: string
  comments: Array<{ kind: string; body: string; x: number; y: number }>
  screenshotPath?: string
}): string {
  const lines = opts.comments
    .map((c, i) => {
      const loc = `${Math.round(c.x * 100)},${Math.round(c.y * 100)}`
      const body = c.body.trim() || '(no text)'
      return `${i + 1}. [${c.kind} @ ${loc}%] ${body}`
    })
    .join('\n')
  const shot = opts.screenshotPath ? `\nScreenshot: ${opts.screenshotPath}` : ''
  return [
    `Operator preview comments from ${opts.tabLabel}${opts.url ? ` (${opts.url})` : ''}`,
    '----',
    lines || '(no comments)',
    '----' + shot
  ].join('\n')
}
