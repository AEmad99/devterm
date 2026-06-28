// Read-only git awareness for the file tree. Backed by `git status --porcelain=1
// --branch` so we can stream one snapshot per directory. Local lookups spawn the
// `git` binary on the host; remote lookups run on the session's exec channel
// (never a second ssh connection). The module is strictly read-only — no
// staging, commits, or any other mutation, by design.
//
// The renderer-facing shape is small on purpose: a branch string, ahead/behind
// counters, and a `path → status` map. The `git` IPC layer (ipc/git.ts) maps
// that to the shared `GitStatus` type and handles caching + live polling.

import { spawn } from 'child_process'
import type { Client } from 'ssh2'
import type { GitFileStatus, GitStatus } from '@shared/types'
import { quoteRemotePath } from './shell-quote'

/** Cap how many file entries we expose per directory to keep the IPC payload sane. */
const MAX_ENTRIES = 5000

/**
 * One porcelain-v1 line, mapped to our compact `GitFileStatus` set. The first
 * column is the index (staged) status, the second is the worktree status; we
 * take the more interesting of the two for the badge ('A' wins over 'M', '?'
 * wins over nothing, etc.).
 */
function pickStatus(index: string, worktree: string): GitFileStatus {
  // Untracked / ignored — porcelain emits '?' / '!' in the second column.
  if (worktree === '?' || worktree === '!') return '?'
  // Conflicts ('U'/'AA'/'DD' etc.) — surface as 'U' for the badge.
  if (worktree === 'U' || index === 'U' || (index !== ' ' && worktree !== ' ' && index !== worktree))
    return 'U'
  // Rename (worktree 'R') — only the short path is parsed below; the badge
  // matches git's own collapsed view.
  if (worktree === 'R' || index === 'R') return 'R'
  // Deleted — both columns agree.
  if (worktree === 'D' || index === 'D') return 'D'
  // Added — staged adds take priority over modified.
  if (index === 'A' || worktree === 'A') return 'A'
  // Anything else with a non-space code in either column is a modification.
  if (worktree !== ' ' || index !== ' ') return 'M'
  // Should not happen for a `--porcelain` line; fall through.
  return 'M'
}

/** Parse the leading two characters and the path of a `git status` porcelain line. */
function parsePorcelainLine(line: string): { status: GitFileStatus; relPath: string } | null {
  if (line.length < 4) return null
  const index = line[0] ?? ' '
  const worktree = line[1] ?? ' '
  let rel = line.slice(3)
  // Renames append " -> newPath"; the user-visible "from" path is more useful
  // for tree badges (the new path gets its own status from a separate line in
  // the same run, but collapsing to the source keeps the filter deterministic).
  if (worktree === 'R' || index === 'R') {
    const arrow = rel.indexOf(' -> ')
    if (arrow !== -1) rel = rel.slice(arrow + 4)
  }
  // Strip surrounding quotes git adds when the path contains unicode.
  if (rel.startsWith('"') && rel.endsWith('"')) {
    try {
      rel = JSON.parse(rel) as string
    } catch {
      /* leave as-is */
    }
  }
  return { status: pickStatus(index, worktree), relPath: rel }
}

/** Parse the `## <branch>...upstream [ahead N, behind M]` header line. */
function parseBranch(line: string): {
  branch: string
  ahead: number
  behind: number
} {
  // Examples:
  //   "## main...origin/main [ahead 2, behind 1]"
  //   "## HEAD (no branch)"
  //   "## main"
  if (!line.startsWith('## ')) return { branch: '', ahead: -1, behind: -1 }
  let body = line.slice(3)
  // The "[ahead N, behind M]" tail is a single trailing bracket; split on it
  // rather than regex so unusual spaces or "[gone]" hints don't trip us.
  const bracket = body.indexOf(' [')
  let counters = ''
  if (bracket !== -1 && body.endsWith(']')) {
    counters = body.slice(bracket + 2, -1)
    body = body.slice(0, bracket)
  }
  // Split branch from upstream ("main...origin/main" → branch=main, upstream=origin/main).
  const sep = body.indexOf('...')
  const branch = sep === -1 ? body : body.slice(0, sep)
  let ahead = -1
  let behind = -1
  for (const piece of counters.split(',')) {
    const m = piece.trim().match(/^ahead (\d+)$/)
    if (m) ahead = Number(m[1])
    const n = piece.trim().match(/^behind (\d+)$/)
    if (n) behind = Number(n[1])
  }
  return { branch, ahead, behind }
}

/** Build the final renderer-facing object from raw porcelain lines. */
function buildStatus(args: {
  branch: string
  ahead: number
  behind: number
  entries: Record<string, GitFileStatus>
  truncated: boolean
}): GitStatus {
  return {
    isRepo: true,
    branch: args.branch,
    ahead: args.ahead,
    behind: args.behind,
    entries: args.entries,
    truncated: args.truncated
  }
}

/** An empty, non-repo result — keeps the call site simple (always returns one). */
function notARepo(): GitStatus {
  return { isRepo: false, branch: '', ahead: -1, behind: -1, entries: {} }
}

/** Spawn `git` for a local working tree. Resolves to the parsed `GitStatus`. */
function runLocalGit(path: string): Promise<GitStatus> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (s: GitStatus) => {
      if (settled) return
      settled = true
      resolve(s)
    }
    let proc: ReturnType<typeof spawn> | null = null
    try {
      proc = spawn('git', ['-C', path, 'status', '--porcelain=1', '--branch'], {
        windowsHide: true
      })
    } catch {
      // `git` not on PATH — treat as "not a repo" so the tree renders normally.
      return finish(notARepo())
    }
    proc.stdout?.on('data', (d: Buffer) => (stdout += d.toString()))
    proc.stderr?.on('data', (d: Buffer) => (stderr += d.toString()))
    proc.on('error', () => finish(notARepo()))
    proc.on('close', (code) => {
      // `not a git repository` is exit code 128 with that exact stderr — the
      // most common case we want to swallow without it being an error.
      if (code !== 0) return finish(notARepo())
      finish(parsePorcelain(stdout))
    })
  })
}

/** Parse the `git status` stdout the same way the local path does. */
function parsePorcelain(stdout: string): GitStatus {
  const lines = stdout.split(/\r?\n/)
  let branch = ''
  let ahead = -1
  let behind = -1
  const entries: Record<string, GitFileStatus> = {}
  let truncated = false
  for (const raw of lines) {
    if (!raw) continue
    if (raw.startsWith('## ')) {
      const h = parseBranch(raw)
      branch = h.branch
      ahead = h.ahead
      behind = h.behind
      continue
    }
    if (Object.keys(entries).length >= MAX_ENTRIES) {
      truncated = true
      continue
    }
    const parsed = parsePorcelainLine(raw)
    if (parsed) entries[parsed.relPath] = parsed.status
  }
  return buildStatus({ branch, ahead, behind, entries, truncated })
}

/** Public alias used by the IPC layer to re-parse remote snapshots. */
export const parsePorcelainFromStdout = parsePorcelain

/** Local entry point: take an absolute path, return git status. */
export function gitStatusLocal(path: string): Promise<GitStatus> {
  return runLocalGit(path)
}

/**
 * Remote entry point: ask the SSH session to run the same porcelain command
 * and parse the result. The exec channel timeout is generous (30s) because
 * large monorepos can take a while on the first snapshot.
 */
export async function gitStatusRemote(
  exec: (cmd: string, timeoutMs?: number) => Promise<{ stdout: string; code: number | null }>,
  path: string
): Promise<GitStatus> {
  // `cd` first so the porcelain output is path-relative (which the parser
  // expects). The path is untrusted (it follows the remote shell cwd), so it
  // must be airtight-quoted — double quotes alone leave `$(...)`/backticks live.
  const cmd = `cd ${quoteRemotePath(path)} && git status --porcelain=1 --branch`
  const res = await exec(cmd, 30000)
  if (res.code !== 0) return notARepo()
  return parsePorcelain(res.stdout)
}

/** Run a `git diff -- <file>` against a working tree. Read-only — no write ops. */
export function gitDiffLocal(path: string, file: string): Promise<string> {
  return new Promise((resolve) => {
    let stdout = ''
    let settled = false
    const finish = (s: string) => {
      if (settled) return
      settled = true
      resolve(s)
    }
    let proc: ReturnType<typeof spawn> | null = null
    try {
      proc = spawn('git', ['-C', path, 'diff', '--', file], { windowsHide: true })
    } catch {
      return finish('')
    }
    proc.stdout?.on('data', (d: Buffer) => (stdout += d.toString()))
    proc.on('error', () => finish(''))
    proc.on('close', () => finish(stdout))
  })
}

/** Remote diff via the session's exec channel. */
export async function gitDiffRemote(
  exec: (cmd: string, timeoutMs?: number) => Promise<{ stdout: string; code: number | null }>,
  path: string,
  file: string
): Promise<string> {
  // Airtight-quote both the directory and the filename (both untrusted).
  const cmd = `cd ${quoteRemotePath(path)} && git diff -- ${quoteRemotePath(file)}`
  const res = await exec(cmd, 30000)
  return res.code === 0 ? res.stdout : ''
}

/**
 * Resolver that takes a session id and runs the named command. The IPC layer
 * adapts the SSH manager's `exec` to this signature so this module doesn't
 * have to know the ssh2 Client directly.
 */
export type RemoteExec = (
  sessionId: string,
  command: string,
  timeoutMs?: number
) => Promise<{ stdout: string; code: number | null }>

/**
 * Run a `git status` over an existing SSH connection. Re-uses the session's
 * `exec` channel — never opens a new one. The Client import here is just a
 * type so the resolver is decoupled from the manager's internal types.
 */
export async function gitStatusViaClient(
  client: Client,
  execOnClient: (
    c: Client,
    cmd: string,
    timeoutMs?: number
  ) => Promise<{ stdout: string; code: number | null }>,
  path: string
): Promise<GitStatus> {
  const cmd = `cd ${quoteRemotePath(path)} && git status --porcelain=1 --branch`
  const res = await execOnClient(client, cmd, 30000)
  if (res.code !== 0) return notARepo()
  return parsePorcelain(res.stdout)
}
