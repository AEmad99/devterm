// Pure parsing/merge helpers for command history, split out of history.ts (no
// Electron imports) so the unit tests can exercise them directly under tsx.

import type { CommandStat, HistoryResult } from '@shared/types'

export interface StoredEntry {
  command: string
  count: number
  /** Epoch ms of the most recent in-app run (drives "recent" ordering). */
  last: number
  /** Kept separate so local commands don't pollute a remote's list and vice versa. */
  scope: 'local' | 'remote'
}

const MAX_OUT = 300 // cap on each returned list

// High-precision patterns for lines that likely embed a secret. Conservative on
// purpose: a false negative just shows a command; a false positive only hides one.
const SENSITIVE: RegExp[] = [
  /\b(pass(?:word|wd)?|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret|bearer)\b/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/
]
export const looksSensitive = (cmd: string): boolean => SENSITIVE.some((re) => re.test(cmd))

export const clean = (line: string): string => line.replace(/\r$/, '').trim()

/** Split history-file text into physical lines. Tolerates LF, CRLF, and lone
 * CR endings, and a missing newline on the final line. */
export const splitLines = (text: string): string[] => text.split(/\r\n|\r|\n/)

/** zsh entries look like `: 1700000000:0;the command` — strip the timestamp prefix. */
export const stripZsh = (line: string): string => {
  const m = /^:\s*\d+:\d+;(.*)$/.exec(line)
  return m ? m[1] : line
}

/** PSReadLine writes multi-line commands with a trailing-backtick continuation:
 * every embedded newline becomes a backtick + a real newline on disk (see
 * WriteHistoryRange / UpdateHistoryFromFile in PSReadLine's History.cs). A naive
 * line split therefore yields junk fragments (`cd D:\foo`` and `D:\foo` for one
 * two-line command) which surface in the palette looking like a concatenated
 * command. Reassemble per PSReadLine's own reader: a line ending in a backtick
 * continues onto the next — strip exactly ONE backtick (a line whose command
 * text itself ends in a backtick is written with two) and join with "\n". An
 * unterminated continuation at EOF (truncated file) is dropped, matching
 * PSReadLine, which never flushes a pending buffer. */
export function parsePsReadLine(text: string): string[] {
  const records: string[] = []
  let pending: string | null = null
  for (const line of splitLines(text)) {
    if (line.endsWith('`')) {
      pending = (pending ?? '') + line.slice(0, -1) + '\n'
    } else if (pending !== null) {
      records.push(pending + line)
      pending = null
    } else {
      records.push(line)
    }
  }
  return records
}

/** Dedupe key for merging. Commands that differ only by casing, quoting, or a
 * trailing path separator run the same thing (`CD X\`, `cd 'X'`, `cd X`), so
 * they collapse to one history entry; the display keeps the original text of
 * the most recent variant. */
export const historyKey = (command: string): string =>
  command
    .toLowerCase()
    .replace(/['"]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[/\\]+$/, '')

/** Merge external (chronological) history + in-app entries into ranked lists. */
export function mergeHistory(externalChrono: string[], inApp: StoredEntry[]): HistoryResult {
  // Keyed by historyKey so variants of one command share a count; the display
  // text is overwritten by each newer occurrence (external is oldest→newest,
  // in-app is applied oldest-first afterwards), keeping the most recent variant.
  const counts = new Map<string, { command: string; count: number }>()
  const bump = (display: string, n: number) => {
    const cur = counts.get(historyKey(display))
    if (cur) {
      cur.command = display
      cur.count += n
    } else counts.set(historyKey(display), { command: display, count: n })
  }

  const ext: string[] = []
  for (const raw of externalChrono) {
    const c = clean(raw)
    // Reassembled multi-line PSReadLine records contain "\n". The palette,
    // inline autosuggest, and run-and-record all assume single-line commands,
    // and a row rendered with the newline collapsed to a space is exactly the
    // "duplicated and concatenated" report — so multi-line records are left
    // out rather than mangled. They remain in the shell's own history file.
    if (!c || c.includes('\n') || looksSensitive(c)) continue
    ext.push(c)
    bump(c, 1)
  }
  for (const e of [...inApp].sort((a, b) => a.last - b.last)) {
    if (!e.command || looksSensitive(e.command)) continue
    bump(e.command, e.count)
  }

  // Recent: in-app runs first (they carry real timestamps and are "what you just
  // did here"), then external newest-first; dedupe by key keeping the first
  // occurrence, which in this order is the most recent variant.
  const recent: string[] = []
  const seen = new Set<string>()
  const ordered = [
    ...[...inApp].sort((a, b) => b.last - a.last).map((e) => e.command),
    ...ext.slice().reverse()
  ]
  for (const c of ordered) {
    if (!c || c.includes('\n') || looksSensitive(c)) continue
    const k = historyKey(c)
    if (seen.has(k)) continue
    seen.add(k)
    recent.push(c)
    if (recent.length >= MAX_OUT) break
  }

  const frequent: CommandStat[] = [...counts.values()]
    .map(({ command, count }) => ({ command, count }))
    .sort((a, b) => b.count - a.count || a.command.localeCompare(b.command))
    .slice(0, MAX_OUT)

  return { recent, frequent }
}
