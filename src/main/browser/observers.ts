/**
 * Per-guest observability ring buffers for agent browser tools.
 *
 * Captures console errors/warnings, navigation failures, and download
 * starts so browser_snapshot / navigate / click results can surface them
 * without a separate read tool.
 */

export type ObsKind = 'console' | 'nav_fail' | 'nav_ok' | 'download'

export interface ObsEntry {
  kind: ObsKind
  at: number
  text: string
}

const MAX_PER_GUEST = 50
const buffers = new Map<number, ObsEntry[]>()
/** Pending notes drained into the next tool result (per wcId). */
const pendingNotes = new Map<number, string[]>()

function push(wcId: number, entry: ObsEntry): void {
  let buf = buffers.get(wcId)
  if (!buf) buffers.set(wcId, (buf = []))
  buf.push(entry)
  if (buf.length > MAX_PER_GUEST) buf.splice(0, buf.length - MAX_PER_GUEST)
}

function note(wcId: number, text: string): void {
  let n = pendingNotes.get(wcId)
  if (!n) pendingNotes.set(wcId, (n = []))
  n.push(text)
  if (n.length > 20) n.splice(0, n.length - 20)
}

export function recordConsole(
  wcId: number,
  level: number,
  message: string,
  source?: string
): void {
  // Electron: 0=debug/log/info-ish varies by version; treat >=2 as warning, >=3 error.
  // Also accept string levels from newer APIs via coercion.
  const sev = level >= 3 ? 'error' : level >= 2 ? 'warning' : null
  if (!sev) return
  const src = source ? ` @ ${source}` : ''
  const text = `${sev}: ${String(message).slice(0, 300)}${src}`
  push(wcId, { kind: 'console', at: Date.now(), text })
}

export function recordNavFail(
  wcId: number,
  code: number,
  description: string,
  url: string
): void {
  const text = `navigation failed: ${description || `ERR_${code}`} (${url.slice(0, 200)})`
  push(wcId, { kind: 'nav_fail', at: Date.now(), text })
  note(wcId, text)
}

export function recordNavOk(wcId: number, url: string): void {
  push(wcId, { kind: 'nav_ok', at: Date.now(), text: `loaded ${url.slice(0, 200)}` })
}

export function recordDownload(wcId: number, filename: string, path: string): void {
  const text = `download started: ${filename} → ${path}`
  push(wcId, { kind: 'download', at: Date.now(), text })
  note(wcId, text)
}

export function clearGuestObs(wcId: number): void {
  buffers.delete(wcId)
  pendingNotes.delete(wcId)
}

/** Console errors/warnings for snapshot tails (does not drain). */
export function consoleTail(wcId: number, max = 8): string[] {
  const buf = buffers.get(wcId) ?? []
  return buf
    .filter((e) => e.kind === 'console')
    .slice(-max)
    .map((e) => e.text)
}

/** Last nav failure still in the buffer (if any). */
export function lastNavFail(wcId: number): string | undefined {
  const buf = buffers.get(wcId) ?? []
  for (let i = buf.length - 1; i >= 0; i--) {
    if (buf[i].kind === 'nav_fail') return buf[i].text
  }
  return undefined
}

/** Drain pending one-shot notes (downloads, nav fails) into a tool result. */
export function drainNotes(wcId: number): string[] {
  const n = pendingNotes.get(wcId)
  if (!n?.length) return []
  pendingNotes.set(wcId, [])
  return n
}

/** Format notes for appending to a tool result string. */
export function formatObsAppendix(wcId: number, opts?: { console?: boolean }): string {
  const parts: string[] = []
  const drained = drainNotes(wcId)
  if (drained.length) parts.push(...drained)
  if (opts?.console) {
    const cons = consoleTail(wcId)
    if (cons.length) parts.push('console (recent):\n' + cons.map((c) => `  - ${c}`).join('\n'))
  }
  return parts.length ? '\n' + parts.join('\n') : ''
}
