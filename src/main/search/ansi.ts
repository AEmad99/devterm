/**
 * Strip ANSI/VT escape sequences and control characters from raw PTY/SSH
 * output so global-search results render as plain text.
 *
 * Covered, in match order:
 *  - CSI: `ESC [` params intermediates final — colors (`\x1b[93m`), cursor
 *    moves (`\x1b[23;20H`), erase, private modes (`\x1b[?25l`), …
 *  - OSC: `ESC ]` payload terminated by BEL or ST (`ESC \`) — cwd (OSC 7),
 *    prompt marks (OSC 133), window titles, hyperlinks. An unterminated OSC
 *    at the end of a chunk is dropped to the chunk end.
 *  - Stray ESC sequences: ESC + optional intermediates + one final byte —
 *    charset selects (`\x1b(B`), DECSC/DECRC (`\x1b7` / `\x1b8`), RIS
 *    (`\x1bc`), and unterminated CSI fragments left at a chunk boundary.
 *
 * Afterwards any remaining C0 control char except TAB, plus DEL, is removed.
 * CR and LF go too: a stored index entry is rendered as a single result row,
 * so line-structure bytes would only merge into the visible text oddly.
 */
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\|$)|\x1b[ -/]*[0-~]/g
const CONTROL_RE = /[\x00-\x08\x0a-\x1f\x7f]/g

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '').replace(CONTROL_RE, '')
}
