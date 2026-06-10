import { app, ipcMain } from 'electron'
import { promises as fs } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { IPC, type CommandStat, type HistoryQuery, type HistoryResult } from '@shared/types'
import type { SSHManager } from '../ssh/manager'

// Command history powering the palette's recent/most-used lists. Two sources are
// merged at query time: commands the user RAN through DevTerm (recorded here into
// userData/history.json) and the host's own shell-history files. Nothing here is
// a secret store — but commands can contain credentials, so `looksSensitive`
// keeps obvious password/token lines out of both the store and the results.

interface StoredEntry {
  command: string
  count: number
  /** Epoch ms of the most recent in-app run (drives "recent" ordering). */
  last: number
  /** Kept separate so local commands don't pollute a remote's list and vice versa. */
  scope: 'local' | 'remote'
}

const storeFile = (): string => join(app.getPath('userData'), 'history.json')

const MAX_STORE = 2000 // distinct in-app entries retained (most-recent kept)
const MAX_LINES = 5000 // tail of each shell-history file we scan
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
const looksSensitive = (cmd: string): boolean => SENSITIVE.some((re) => re.test(cmd))

const clean = (line: string): string => line.replace(/\r$/, '').trim()

async function readStore(): Promise<StoredEntry[]> {
  try {
    const raw = await fs.readFile(storeFile(), 'utf8')
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed?.entries) ? parsed.entries : []
  } catch {
    return [] // missing or unreadable → no in-app history yet
  }
}

async function writeStore(entries: StoredEntry[]): Promise<void> {
  const tmp = storeFile() + '.tmp'
  await fs.writeFile(tmp, JSON.stringify({ version: 1, entries }, null, 2), 'utf8')
  await fs.rename(tmp, storeFile()) // atomic replace so a crash mid-write can't corrupt the store
}

/** Read a text file's lines (best-effort); empty if missing/unreadable. */
async function readLines(path: string): Promise<string[]> {
  try {
    return (await fs.readFile(path, 'utf8')).split(/\r?\n/)
  } catch {
    return []
  }
}

/** zsh entries look like `: 1700000000:0;the command` — strip the timestamp prefix. */
const stripZsh = (line: string): string => {
  const m = /^:\s*\d+:\d+;(.*)$/.exec(line)
  return m ? m[1] : line
}

/** The local machine's shell history, oldest→newest. PowerShell (PSReadLine) on
 * Windows, plus bash/zsh history if present (WSL, git-bash, Linux/mac local). */
async function localHistory(): Promise<string[]> {
  const out: string[] = []
  if (process.platform === 'win32' && process.env.APPDATA) {
    // PSReadLine stores history per host, and PowerShell 7 (pwsh, which DevTerm
    // prefers) uses a different folder than Windows PowerShell 5.1. Read both —
    // PS7 first since it's the more likely active shell.
    const ps = (...seg: string[]) =>
      join(process.env.APPDATA!, ...seg, 'PSReadLine', 'ConsoleHost_history.txt')
    out.push(...(await readLines(ps('Microsoft', 'PowerShell'))))
    out.push(...(await readLines(ps('Microsoft', 'Windows', 'PowerShell'))))
  }
  const home = homedir()
  out.push(...(await readLines(join(home, '.bash_history'))))
  out.push(...(await readLines(join(home, '.zsh_history'))).map(stripZsh))
  return out.slice(-MAX_LINES)
}

/** A remote session's shell history, read over its EXISTING SSH client (no second
 * connection). `tail` bounds the read; zsh timestamp prefixes are stripped. */
async function remoteHistory(ssh: SSHManager, sessionId: string): Promise<string[]> {
  const cmd =
    `tail -n ${MAX_LINES} ~/.bash_history 2>/dev/null; ` +
    `tail -n ${MAX_LINES} ~/.zsh_history 2>/dev/null`
  try {
    const { stdout } = await ssh.exec(sessionId, cmd, 8000)
    return stdout.split(/\r?\n/).map(stripZsh)
  } catch {
    return [] // unknown session / channel failure → just no external history
  }
}

/** Merge external (chronological) history + in-app entries into ranked lists. */
function build(externalChrono: string[], inApp: StoredEntry[]): HistoryResult {
  const counts = new Map<string, number>()
  const bump = (cmd: string, n: number) => counts.set(cmd, (counts.get(cmd) ?? 0) + n)

  const ext: string[] = []
  for (const raw of externalChrono) {
    const c = clean(raw)
    if (!c || looksSensitive(c)) continue
    ext.push(c)
    bump(c, 1)
  }
  for (const e of inApp) {
    if (!e.command || looksSensitive(e.command)) continue
    bump(e.command, e.count)
  }

  // Recent: in-app runs first (they carry real timestamps and are "what you just
  // did here"), then external newest-first; dedupe keeping the first occurrence.
  const recent: string[] = []
  const seen = new Set<string>()
  const ordered = [
    ...[...inApp].sort((a, b) => b.last - a.last).map((e) => e.command),
    ...ext.slice().reverse()
  ]
  for (const c of ordered) {
    if (!c || seen.has(c) || looksSensitive(c)) continue
    seen.add(c)
    recent.push(c)
    if (recent.length >= MAX_OUT) break
  }

  const frequent: CommandStat[] = [...counts.entries()]
    .map(([command, count]) => ({ command, count }))
    .sort((a, b) => b.count - a.count || a.command.localeCompare(b.command))
    .slice(0, MAX_OUT)

  return { recent, frequent }
}

export function registerHistoryIpc(ssh: SSHManager): void {
  ipcMain.handle(IPC.historyRecord, async (_e, command: string, scope: 'local' | 'remote') => {
    const cmd = clean(command)
    if (!cmd || cmd.length > 2000 || looksSensitive(cmd)) return
    const entries = await readStore()
    const idx = entries.findIndex((x) => x.command === cmd && x.scope === scope)
    if (idx >= 0) entries[idx] = { ...entries[idx], count: entries[idx].count + 1, last: Date.now() }
    else entries.push({ command: cmd, count: 1, last: Date.now(), scope })
    entries.sort((a, b) => b.last - a.last) // keep the most-recently-used within the cap
    await writeStore(entries.slice(0, MAX_STORE))
  })

  ipcMain.handle(IPC.historyQuery, async (_e, q: HistoryQuery): Promise<HistoryResult> => {
    const inApp = (await readStore()).filter((e) => e.scope === q.scope)
    const external =
      q.scope === 'remote' && q.sessionId
        ? await remoteHistory(ssh, q.sessionId)
        : q.scope === 'local'
          ? await localHistory()
          : []
    return build(external, inApp)
  })
}
