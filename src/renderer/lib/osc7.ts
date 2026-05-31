/**
 * Parse an OSC 7 payload (`file://host/path`) into a usable path. Windows paths
 * arrive as `/C:/Users/...` and are converted to `C:\Users\...`.
 */
export function parseOsc7(data: string): string | null {
  const m = /^file:\/\/([^/]*)(\/.*)$/.exec(data.trim())
  if (!m) return null
  let p: string
  try {
    p = decodeURIComponent(m[2])
  } catch {
    p = m[2]
  }
  if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1).replace(/\//g, '\\')
  return p
}
