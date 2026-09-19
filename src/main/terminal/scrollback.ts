/** Default persisted tail; the hard cap prevents a restore file from growing with xterm. */
export const DEFAULT_PERSISTED_SCROLLBACK_LINES = 2_000
export const MAX_PERSISTED_SCROLLBACK_LINES = 10_000
export const MAX_PERSISTED_SCROLLBACK_BYTES = 2 * 1024 * 1024

function suffixWithinBytes(value: string, maxBytes: number): string {
  if (!value || maxBytes <= 0) return ''
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value

  let low = 0
  let high = value.length
  while (low < high) {
    const mid = Math.floor((low + high) / 2)
    if (Buffer.byteLength(value.slice(mid), 'utf8') <= maxBytes) high = mid
    else low = mid + 1
  }
  let start = low
  if (start > 0 && start < value.length) {
    const code = value.charCodeAt(start)
    if (code >= 0xdc00 && code <= 0xdfff) start++
  }
  return value.slice(start)
}

/** Keep the newest raw lines while retaining ANSI bytes exactly. */
export function trimSessionScrollback(
  raw: string,
  maxLines = DEFAULT_PERSISTED_SCROLLBACK_LINES,
  maxBytes = MAX_PERSISTED_SCROLLBACK_BYTES
): string {
  if (!raw) return ''
  const lineLimit = Math.max(
    1,
    Math.min(
      MAX_PERSISTED_SCROLLBACK_LINES,
      Math.floor(Number.isFinite(maxLines) ? maxLines : DEFAULT_PERSISTED_SCROLLBACK_LINES)
    )
  )
  const byteLimit = Math.max(
    1,
    Math.min(
      MAX_PERSISTED_SCROLLBACK_BYTES,
      Math.floor(Number.isFinite(maxBytes) ? maxBytes : MAX_PERSISTED_SCROLLBACK_BYTES)
    )
  )
  // Keep each newline attached to its preceding line, so replay does not
  // invent or remove terminal line endings.
  const lines = raw.match(/[^\n]*(?:\n|$)/g)?.filter((line) => line.length > 0) ?? []
  return suffixWithinBytes(lines.slice(-lineLimit).join(''), byteLimit)
}
