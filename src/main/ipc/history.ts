import { app, ipcMain } from 'electron'
import { promises as fs } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { IPC, type HistoryQuery, type HistoryResult } from '@shared/types'
import type { SSHManager } from '../ssh/manager'
import {
  clean,
  historyKey,
  looksSensitive,
  mergeHistory,
  parsePsReadLine,
  splitLines,
  stripZsh,
  type StoredEntry
} from './history-parse'

// Command history powering the palette's recent/most-used lists. Two sources are
// merged at query time: commands the user RAN through DevTerm (recorded here into
// userData/history.json) and the host's own shell-history files. Nothing here is
// a secret store — but commands can contain credentials, so `looksSensitive`
// keeps obvious password/token lines out of both the store and the results.

const storeFile = (): string => join(app.getPath('userData'), 'history.json')

const MAX_STORE = 2000 // distinct in-app entries retained (most-recent kept)
const MAX_LINES = 5000 // tail of each shell-history file we scan

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

/** Read a text file (best-effort); empty if missing/unreadable. */
async function readText(path: string): Promise<string> {
  try {
    return await fs.readFile(path, 'utf8')
  } catch {
    return ''
  }
}

/** The local machine's shell history, oldest→newest. PowerShell (PSReadLine) on
 * Windows, plus bash/zsh history if present (WSL, git-bash, Linux/mac local). */
async function localHistory(): Promise<string[]> {
  const out: string[] = []
  if (process.platform === 'win32' && process.env.APPDATA) {
    // PSReadLine stores history per host, and PowerShell 7 (pwsh, which DevTerm
    // prefers) uses a different folder than Windows PowerShell 5.1. Read both —
    // PS7 first since it's the more likely active shell. The format is NOT one
    // command per line: multi-line commands use a trailing-backtick continuation,
    // which parsePsReadLine reassembles.
    const ps = (...seg: string[]) =>
      join(process.env.APPDATA!, ...seg, 'PSReadLine', 'ConsoleHost_history.txt')
    out.push(...parsePsReadLine(await readText(ps('Microsoft', 'PowerShell'))))
    out.push(...parsePsReadLine(await readText(ps('Microsoft', 'Windows', 'PowerShell'))))
  }
  const home = homedir()
  out.push(...splitLines(await readText(join(home, '.bash_history'))))
  out.push(...splitLines(await readText(join(home, '.zsh_history'))).map(stripZsh))
  return out.slice(-MAX_LINES)
}

/** A remote session's shell history, read over its EXISTING SSH client (no second
 * connection). `tail` bounds the read; zsh timestamp prefixes are stripped. */
async function remoteHistory(ssh: SSHManager, sessionId: string): Promise<string[]> {
  // The `echo` between the two tails matters: if ~/.bash_history's final line
  // has no trailing newline, tail emits it unterminated and the first zsh line
  // would glue onto it, fusing two commands into one bogus entry. The blank
  // line the echo adds is filtered out downstream.
  const cmd =
    `tail -n ${MAX_LINES} ~/.bash_history 2>/dev/null; echo; ` +
    `tail -n ${MAX_LINES} ~/.zsh_history 2>/dev/null`
  try {
    const { stdout } = await ssh.exec(sessionId, cmd, 8000)
    return splitLines(stdout).map(stripZsh)
  } catch {
    return [] // unknown session / channel failure → just no external history
  }
}

export function registerHistoryIpc(ssh: SSHManager): void {
  ipcMain.handle(IPC.historyRecord, async (_e, command: string, scope: 'local' | 'remote') => {
    const cmd = clean(command)
    if (!cmd || cmd.length > 2000 || looksSensitive(cmd)) return
    const entries = await readStore()
    // Match by historyKey so re-running a variant (`CD X\` after `cd 'X'`)
    // bumps the existing entry instead of forking a near-duplicate; the stored
    // display text follows the most recent variant.
    const idx = entries.findIndex(
      (x) => x.scope === scope && historyKey(x.command) === historyKey(cmd)
    )
    if (idx >= 0)
      entries[idx] = {
        ...entries[idx],
        command: cmd,
        count: entries[idx].count + 1,
        last: Date.now()
      }
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
    return mergeHistory(external, inApp)
  })
}
