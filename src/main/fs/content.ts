// Helpers for reading/writing file contents as editable text, shared by the
// local FS and SFTP backends. Editing is text-only; binary files are rejected.

/**
 * Heuristic binary sniff: a NUL byte in the first 8 KB is a strong signal the
 * file is not UTF-8 text. Cheap and good enough to keep the editor from
 * mangling binaries.
 */
export function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  return false
}

/** Decode bytes to text, stripping a leading UTF-8 BOM if present. */
export function decodeText(buf: Buffer): string {
  let s = buf.toString('utf8')
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1)
  return s
}

/** Encode editor text to bytes (UTF-8, no BOM). */
export function encodeText(content: string): Buffer {
  return Buffer.from(content, 'utf8')
}

/** Detect the dominant line ending so saves don't flip a CRLF file to LF. */
export function detectEol(content: string): '\n' | '\r\n' {
  const crlf = content.split('\r\n').length - 1
  const lf = content.split('\n').length - 1 - crlf
  return crlf > lf ? '\r\n' : '\n'
}
