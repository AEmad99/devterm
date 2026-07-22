// Git awareness + Warp-style panel operations. Backed by `git status
// --porcelain=1 --branch` for the file-tree snapshot, plus a full read-side
// (branches, remotes, log, stash, tags, fileAt, blame, show, fullDiff,
// contributors) and a full write-side (checkout, branch create/delete/rename,
// fetch/pull/push, stash apply/drop/pop, commit, stage/unstage/discard, tag
// create/delete, remote add/remove, merge). Local lookups spawn the `git`
// binary on the host; remote lookups run on the session's exec channel
// (never a second SSH connection). The `git` IPC layer (ipc/git.ts) maps the
// results to the shared types and handles caching + live polling. All writes
// invalidate the 5s status cache so the next read re-runs git.
// same local-spawn / remote-exec plumbing so the panel works the same way
// locally and over SSH.

import { spawn } from 'child_process'
import type { Client } from 'ssh2'
import type {
  GitBlameLine,
  GitBranch,
  GitBranches,
  GitCommandResult,
  GitContributor,
  GitFileStatus,
  GitLogEntry,
  GitRemote,
  GitShowResult,
  GitStashEntry,
  GitStatus,
  GitTag
} from '@shared/types'
import { quoteRemotePath, shQuote } from '../utils/shell-quote'

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
  // Real unmerged/conflict codes only (not AM/AD/RM, which are normal
  // staged-then-edited / staged-add-then-deleted pairs).
  const xy = index + worktree
  if (
    xy === 'UU' ||
    xy === 'AA' ||
    xy === 'DD' ||
    xy === 'AU' ||
    xy === 'UA' ||
    xy === 'DU' ||
    xy === 'UD' ||
    worktree === 'U' ||
    index === 'U'
  )
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
  // Renames append " -> newPath"; use the destination path (after the arrow)
  // so the tree badge lands on the file the user will see in the working tree.
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

// ---------------------------------------------------------------------------
// Common execution helpers for the read/write-side additions below.
//
// Local: spawn `git -C <path> <args…>`. Remote: build a single `cd <path> && git
// <args…>` line, run it through the SSH exec channel. Both surfaces return a
// shared `GitCommandResult` so the panel UI can render the same shape
// regardless of where the work happened.
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 30_000
/** Pull/push/fetch are network-heavy; allow more time before timing out. */
const NETWORK_TIMEOUT_MS = 120_000

interface ExecLike {
  (
    cmd: string,
    timeoutMs?: number
  ): Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean }>
}

/** Spawn a local `git` invocation. Returns a shared result envelope. */
function runLocalGitCmd(
  cwd: string,
  args: string[],
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<GitCommandResult> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (r: GitCommandResult) => {
      if (settled) return
      settled = true
      resolve(r)
    }
    let proc: ReturnType<typeof spawn> | null = null
    try {
      proc = spawn('git', ['-C', cwd, ...args], { windowsHide: true })
    } catch {
      // `git` not on PATH — surface as a failure so the UI can render it.
      return finish({ ok: false, code: null, stdout: '', stderr: 'git not on PATH', timedOut: false })
    }
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      proc?.kill()
      finish({ ok: false, code: null, stdout, stderr, timedOut: true })
    }, timeoutMs)
    proc.stdout?.on('data', (d: Buffer) => (stdout += d.toString()))
    proc.stderr?.on('data', (d: Buffer) => (stderr += d.toString()))
    proc.on('error', () => {
      clearTimeout(timer)
      finish({ ok: false, code: null, stdout, stderr: stderr || 'git spawn failed', timedOut: false })
    })
    proc.on('close', (code) => {
      clearTimeout(timer)
      finish({ ok: code === 0, code: code ?? null, stdout, stderr, timedOut })
    })
  })
}

/** Build a remote command line for an arbitrary git invocation. */
function buildRemoteGit(cwd: string, args: string[]): string {
  // Args are all under our control (literal git flags, not untrusted text),
  // so plain quoting with single-quote escaping is enough. Anything that
  // arrives from the renderer as a file path must already have been wrapped
  // with `quoteRemotePath` by the caller.
  const quoted = args.map((a) => shQuote(a)).join(' ')
  return `cd ${quoteRemotePath(cwd)} && git ${quoted}`
}

/** Public exec resolver signature used by the IPC layer (delegated to RemoteExec above). */
// (Re-exported as RemoteExec above to keep the type stable for legacy callers.)

/** Run a local mutation command. */
export async function gitLocal(
  cwd: string,
  args: string[],
  timeoutMs?: number
): Promise<GitCommandResult> {
  return runLocalGitCmd(cwd, args, timeoutMs)
}

/** Run a remote mutation command over the session's exec channel. */
export async function gitRemote(
  exec: ExecLike,
  cwd: string,
  args: string[],
  timeoutMs?: number
): Promise<GitCommandResult> {
  const cmd = buildRemoteGit(cwd, args)
  const r = await exec(cmd, timeoutMs ?? DEFAULT_TIMEOUT_MS)
  return {
    ok: r.code === 0 && !r.timedOut,
    code: r.code,
    stdout: r.stdout,
    stderr: r.stderr,
    timedOut: r.timedOut
  }
}

// ---------------------------------------------------------------------------
// Branch / remote listing (read-side)
// ---------------------------------------------------------------------------

interface RawBranchLine {
  name: string
  sha: string
  upstream: string | null
  ahead: number
  behind: number
  remote: boolean
  current: boolean
}

/** Parse `git for-each-ref` output (one branch per line, custom format). */
function parseForEachRef(stdout: string): RawBranchLine[] {
  const out: RawBranchLine[] = []
  for (const line of stdout.split(/\r?\n/)) {
    if (!line) continue
    // %(HEAD) %(upstream:short) %(upstream:track) %(objectname:short) %(refname:short)
    // Fields are separated by the literal sentinel \x01 (SOH) so spaces in
    // branch names survive the round trip.
    const [head, upstreamShort, track, sha, refname] = line.split('\x01')
    if (!sha || !refname) continue
    const remote = refname.startsWith('refs/remotes/')
    const name = remote
      ? refname.replace(/^refs\/remotes\//, '')
      : refname.replace(/^refs\/heads\//, '')
    let ahead = -1
    let behind = -1
    if (track) {
      const a = /ahead (\d+)/.exec(track)
      const b = /behind (\d+)/.exec(track)
      if (a) ahead = Number(a[1])
      if (b) behind = Number(b[1])
    }
    out.push({
      name,
      sha,
      upstream: upstreamShort || null,
      ahead,
      behind,
      remote,
      current: head === '*'
    })
  }
  return out
}

/** Branch listing (local + remote refs) for a working tree. */
export async function gitBranchesLocal(cwd: string): Promise<GitBranches> {
  const r = await runLocalGitCmd(cwd, [
    'for-each-ref',
    '--format=%(HEAD)%00%(upstream:short)%00%(upstream:track)%00%(objectname:short)%00%(refname:short)',
    'refs/heads',
    'refs/remotes'
  ])
  if (!r.ok) return { branches: [], defaultBranch: null }
  return shapeBranches(parseForEachRef(r.stdout))
}

export async function gitBranchesRemote(
  exec: ExecLike,
  cwd: string
): Promise<GitBranches> {
  const r = await gitRemote(
    exec,
    cwd,
    [
      'for-each-ref',
      '--format=%(HEAD)%00%(upstream:short)%00%(upstream:track)%00%(objectname:short)%00%(refname:short)',
      'refs/heads',
      'refs/remotes'
    ],
    30_000
  )
  if (!r.ok) return { branches: [], defaultBranch: null }
  return shapeBranches(parseForEachRef(r.stdout))
}

function shapeBranches(raw: RawBranchLine[]): GitBranches {
  const branches: GitBranch[] = raw.map((b) => ({
    name: b.name,
    sha: b.sha,
    upstream: b.upstream,
    current: b.current,
    remote: b.remote,
    ahead: b.ahead,
    behind: b.behind
  }))
  // Prefer the current branch's upstream; otherwise origin/HEAD; otherwise the
  // first non-remote branch we can find. Matches what `gh repo view` shows.
  const current = branches.find((b) => b.current)
  let defaultBranch: string | null = null
  if (current?.upstream) defaultBranch = current.upstream
  if (!defaultBranch) {
    const originHead = branches.find((b) => b.name === 'origin/HEAD' || b.name === 'origin/main')
    if (originHead) defaultBranch = originHead.name
  }
  if (!defaultBranch) {
    const local = branches.find((b) => !b.remote && (b.name === 'main' || b.name === 'master'))
    if (local) defaultBranch = local.name
  }
  return { branches, defaultBranch }
}

/** Remotes list (`git remote -v`). */
export async function gitRemotesLocal(cwd: string): Promise<GitRemote[]> {
  const r = await runLocalGitCmd(cwd, ['remote', '-v'])
  return parseRemotes(r.stdout)
}

export async function gitRemotesRemote(exec: ExecLike, cwd: string): Promise<GitRemote[]> {
  const r = await gitRemote(exec, cwd, ['remote', '-v'])
  return parseRemotes(r.stdout)
}

function parseRemotes(stdout: string): GitRemote[] {
  const map = new Map<string, GitRemote>()
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue
    // "<name>\t<url> (<fetch|push>)"
    const m = /^(.+?)\s+(.+?)\s+\((fetch|push)\)\s*$/.exec(line)
    if (!m) continue
    const [, name, url, kind] = m
    const cur = map.get(name) ?? { name, fetchUrl: '', pushUrl: '' }
    if (kind === 'fetch') cur.fetchUrl = url
    else cur.pushUrl = url
    map.set(name, cur)
  }
  return [...map.values()]
}

// ---------------------------------------------------------------------------
// Log (`git log`)
// ---------------------------------------------------------------------------

const LOG_FORMAT =
  '%H%x01%h%x01%an%x01%ae%x01%cn%x01%ce%x01%aI%x01%cI%x01%P%x01%D%x01%s%x01%b'
//  ^sha  ^short ^an   ^ae   ^cn   ^ce   ^aI  ^cI  ^parents ^decoration ^subject ^body
// Records are NUL-terminated by `-z`; internal fields are split on `\x01`
// (SOH) so they never collide with the NUL record separator. Body lines
// (after the first newline in a record block) are preserved verbatim until
// the next NUL.

const LOG_FIELDS = [
  'sha',
  'shortSha',
  'authorName',
  'authorEmail',
  'committerName',
  'committerEmail',
  'authorDate',
  'committerDate',
  'parent',
  'refs',
  'subject',
  'body'
] as const


/** Parse the -z-terminated, NUL-field-delimited git log output. */
function parseLog(stdout: string): GitLogEntry[] {
  // With -z, each commit is NUL-terminated. Internal fields are still split
  // on the same byte from the format string. Body lines are preserved
  // verbatim within the record block; they are everything after the first
  // newline of the record up to the trailing NUL.
  const out: GitLogEntry[] = []
  const NUL = String.fromCharCode(0)
  const records = stdout.split(NUL).filter((r) => r.length > 0)
  for (const rec of records) {
    const newlineIdx = rec.indexOf('\n')
    const metaLine = newlineIdx === -1 ? rec : rec.slice(0, newlineIdx)
    const body =
      newlineIdx === -1
        ? ''
        : rec
            .slice(newlineIdx + 1)
            .replace(/^\n/, '')
            .replace(/\n+$/, '')
    const metaParts = metaLine.split('\x01')
    // The trailing \x00 after %b produces an empty final element. Drop it.
    const trimmed =
      metaParts[metaParts.length - 1] === '' ? metaParts.slice(0, -1) : metaParts
    const meta: Record<string, string> = {}
    LOG_FIELDS.forEach((f, i) => {
      meta[f] = trimmed[i] ?? ''
    })
    const parentList = meta.parent ? meta.parent.split(' ').filter(Boolean) : []
    out.push({
      sha: meta.sha,
      shortSha: meta.shortSha,
      subject: meta.subject.trim(),
      body,
      authorName: meta.authorName,
      authorEmail: meta.authorEmail,
      committerName: meta.committerName,
      committerEmail: meta.committerEmail,
      authorDate: meta.authorDate,
      committerDate: meta.committerDate,
      parent: parentList[0] ?? null,
      parentCount: parentList.length,
      parents: parentList,
      refs: meta.refs.split(', ').filter(Boolean)
    })
  }
  return out
}
function logArgs(opts: { maxCount?: number; ref?: string; file?: string }): string[] {
  const max = opts.maxCount ?? 100
  const range = opts.ref ? [opts.ref] : ['HEAD']
  const args = [
    'log',
    `-n${max}`,
    // -z NUL-terminates each commit so multi-commit output is unambiguous.
    // --topo-order puts parents before children; required for the graph
    // layout pass in the renderer.
    '-z',
    '--topo-order',
    '--no-color',
    `--format=${LOG_FORMAT}`
  ]
  // Revision must come BEFORE `-- <path>` or git treats the ref as a pathspec
  // and per-file history silently always shows HEAD.
  args.push(...range)
  if (opts.file) args.push('--', opts.file)
  return args
}


/** Pretty-printed log (used as a fallback when our parser misses a record). */
export async function gitLogLocal(
  cwd: string,
  opts: { maxCount?: number; ref?: string; file?: string } = {}
): Promise<GitLogEntry[]> {
  const args = logArgs(opts)
  const r = await runLocalGitCmd(cwd, args)
  if (!r.ok) return []
  return parseLog(r.stdout)
}

export async function gitLogRemote(
  exec: ExecLike,
  cwd: string,
  opts: { maxCount?: number; ref?: string; file?: string } = {}
): Promise<GitLogEntry[]> {
  const args = logArgs(opts)
  const r = await gitRemote(exec, cwd, args)
  if (!r.ok) return []
  return parseLog(r.stdout)
}

// ---------------------------------------------------------------------------
// Stash (`git stash list`)
// ---------------------------------------------------------------------------

function parseStash(stdout: string): GitStashEntry[] {
  const out: GitStashEntry[] = []
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue
    // "stash@{0}: WIP on main: abc1234 Subject"
    const m = /^(stash@\{\d+\}):\s+(.+)$/.exec(line)
    if (!m) continue
    const ref = m[1]
    const rest = m[2]
    const branchMatch = /on ([^:]+):\s+([0-9a-f]+)\s+(.*)$/.exec(rest)
    const branch = branchMatch ? branchMatch[1].trim() : null
    const sha = branchMatch ? branchMatch[2] : ''
    const message = branchMatch ? branchMatch[3].trim() : rest.trim()
    // Use the WIP timestamp we don't have; treat as unknown (0).
    out.push({ ref, message, sha, branch, date: 0 })
  }
  return out
}

export async function gitStashListLocal(cwd: string): Promise<GitStashEntry[]> {
  const r = await runLocalGitCmd(cwd, [
    'stash',
    'list',
    '--format=%gd%x00%gs%x00%ct'
  ])
  if (!r.ok) return []
  // Prefer the structured parse — fall back to legacy text parse on mismatch.
  const structured: GitStashEntry[] = []
  for (const line of r.stdout.split(/\r?\n/)) {
    if (!line) continue
    const [ref, subject, ts] = line.split('\x00')
    if (!ref) continue
    const branchMatch = /on ([^:]+):\s+([0-9a-f]+)\s+(.*)$/.exec(subject || '')
    structured.push({
      ref,
      message: branchMatch ? branchMatch[3].trim() : subject || '',
      sha: branchMatch ? branchMatch[2] : '',
      branch: branchMatch ? branchMatch[1].trim() : null,
      date: Number(ts || 0) * 1000
    })
  }
  if (structured.length) return structured
  return parseStash(r.stdout)
}

export async function gitStashListRemote(exec: ExecLike, cwd: string): Promise<GitStashEntry[]> {
  const r = await gitRemote(exec, cwd, ['stash', 'list', '--format=%gd%x00%gs%x00%ct'])
  if (!r.ok) return []
  const structured: GitStashEntry[] = []
  for (const line of r.stdout.split(/\r?\n/)) {
    if (!line) continue
    const [ref, subject, ts] = line.split('\x00')
    if (!ref) continue
    const branchMatch = /on ([^:]+):\s+([0-9a-f]+)\s+(.*)$/.exec(subject || '')
    structured.push({
      ref,
      message: branchMatch ? branchMatch[3].trim() : subject || '',
      sha: branchMatch ? branchMatch[2] : '',
      branch: branchMatch ? branchMatch[1].trim() : null,
      date: Number(ts || 0) * 1000
    })
  }
  if (structured.length) return structured
  return parseStash(r.stdout)
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

function parseTags(stdout: string): GitTag[] {
  const out: GitTag[] = []
  for (const line of stdout.split(/\r?\n/)) {
    if (!line) continue
    // %(*objectname)%00%(refname:short)%00%(subject)%00%(taggername)%00%(taggeremail)%00%(*taggerdate:iso8601)
    const [sha, name, subject, tagger, email, date, kind] = line.split('\x00')
    if (!sha || !name) continue
    const annotated = kind === 'tag'
    out.push({
      name,
      sha,
      message: subject || '',
      taggerName: tagger || '',
      taggerEmail: email || '',
      date: date || '',
      annotated
    })
  }
  return out
}

export async function gitTagsLocal(cwd: string): Promise<GitTag[]> {
  const r = await runLocalGitCmd(cwd, [
    'for-each-ref',
    '--format=%(objectname)%00%(refname:short)%00%(subject)%00%(taggername)%00%(taggeremail)%00%(taggerdate:iso8601)%00%(*objecttype)',
    'refs/tags'
  ])
  if (!r.ok) return []
  return parseTags(r.stdout)
}

export async function gitTagsRemote(exec: ExecLike, cwd: string): Promise<GitTag[]> {
  const r = await gitRemote(
    exec,
    cwd,
    [
      'for-each-ref',
      '--format=%(objectname)%00%(refname:short)%00%(subject)%00%(taggername)%00%(taggeremail)%00%(taggerdate:iso8601)%00%(*objecttype)',
      'refs/tags'
    ],
    30_000
  )
  if (!r.ok) return []
  return parseTags(r.stdout)
}

// ---------------------------------------------------------------------------
// File contents at a ref / blame / show / full diff / contributors
// ---------------------------------------------------------------------------

export async function gitFileAtLocal(
  cwd: string,
  file: string,
  ref?: string
): Promise<string> {
  const args = ['show', `${ref || 'HEAD'}:${file}`]
  const r = await runLocalGitCmd(cwd, args)
  return r.ok ? r.stdout : ''
}

export async function gitFileAtRemote(
  exec: ExecLike,
  cwd: string,
  file: string,
  ref?: string
): Promise<string> {
  const r = await gitRemote(exec, cwd, ['show', `${ref || 'HEAD'}:${file}`])
  return r.ok ? r.stdout : ''
}

export async function gitBlameLocal(cwd: string, file: string): Promise<GitBlameLine[]> {
  const r = await runLocalGitCmd(cwd, [
    'blame',
    '--line-porcelain',
    '--',
    file
  ])
  if (!r.ok) return []
  return parseBlame(r.stdout)
}

export async function gitBlameRemote(
  exec: ExecLike,
  cwd: string,
  file: string
): Promise<GitBlameLine[]> {
  const r = await gitRemote(exec, cwd, ['blame', '--line-porcelain', '--', file])
  if (!r.ok) return []
  return parseBlame(r.stdout)
}

function parseBlame(stdout: string): GitBlameLine[] {
  const out: GitBlameLine[] = []
  const lines = stdout.split(/\r?\n/)
  let i = 0
  while (i < lines.length) {
    const header = lines[i]
    if (!header) {
      i++
      continue
    }
    // Header: "<sha> <orig-line> <final-line> [<count>]"
    const [sha, , finalLine] = header.split(' ')
    let author = ''
    let date = ''
    let lineText = ''
    i++
    while (i < lines.length) {
      const k = lines[i]
      if (k.startsWith('author ')) author = k.slice('author '.length)
      else if (k.startsWith('author-time ')) {
        const t = Number(k.slice('author-time '.length))
        if (!Number.isNaN(t)) date = new Date(t * 1000).toISOString()
      } else if (k.startsWith('author-mail ')) {
        // ignore for now; we only render the name in the UI
      } else if (k.startsWith('\t')) {
        lineText = k.slice(1)
        i++
        break
      }
      i++
    }
    if (sha && finalLine) {
      out.push({
        line: Number(finalLine),
        sha,
        shortSha: sha.slice(0, 7),
        author,
        date,
        text: lineText
      })
    }
  }
  return out
}

export async function gitShowLocal(cwd: string, sha: string): Promise<GitShowResult | null> {
  const r = await runLocalGitCmd(cwd, [
    'show',
    '--format=%H%x01%h%x01%s%x01%an%x01%ae%x01%aI%x01%b%x02',
    '--numstat',
    '--patch',
    sha
  ])
  if (!r.ok) return null
  return parseShow(r.stdout)
}

export async function gitShowRemote(
  exec: ExecLike,
  cwd: string,
  sha: string
): Promise<GitShowResult | null> {
  const r = await gitRemote(exec, cwd, [
    'show',
    '--format=%H%x01%h%x01%s%x01%an%x01%ae%x01%aI%x01%b%x02',
    '--numstat',
    '--patch',
    sha
  ])
  if (!r.ok) return null
  return parseShow(r.stdout)
}

function parseShow(stdout: string): GitShowResult | null {
  // Format: %H\x01%h\x01%s\x01%an\x01%ae\x01%aI\x01%b\x02
  // Fields are SOH-separated; \x02 (STX) terminates the body so multi-line
  // bodies don't bleed into the numstat/patch section that follows.
  const sohParts = stdout.split('\x01')
  if (sohParts.length < 7) return null
  const sha = sohParts[0]
  const shortSha = sohParts[1]
  const subject = sohParts[2]
  const authorName = sohParts[3] || ''
  const authorEmail = sohParts[4] || ''
  const authorDate = sohParts[5] || ''
  // The 7th element is: body\x02\n<numstat>\n\n<patch>
  const bodyAndRest = sohParts[6] || ''
  const stxIdx = bodyAndRest.indexOf('\x02')
  const body = stxIdx === -1 ? bodyAndRest.trim() : bodyAndRest.slice(0, stxIdx).replace(/^\n+/, '').replace(/\n+$/, '')
  const rest = stxIdx === -1 ? '' : bodyAndRest.slice(stxIdx + 1)

  // Parse numstat rows from `rest`; patch is everything after the first blank.
  const restLines = rest.split(/\r?\n/).slice(1) // skip the leading newline
  const files: GitShowResult['files'] = []
  let patchStart = 0
  for (let i = 0; i < restLines.length; i++) {
    const line = restLines[i]
    if (line === '') {
      patchStart = i + 1
      break
    }
    const m = /^(\d+|-)\s+(\d+|-)\s+(.+)$/.exec(line)
    if (m) {
      const [, addStr, delStr, path] = m
      files.push({
        path,
        status: 'M',
        additions: addStr === '-' ? 0 : Number(addStr),
        deletions: delStr === '-' ? 0 : Number(delStr)
      })
    }
  }
  const patch = restLines.slice(patchStart).join('\n')
  return {
    sha,
    shortSha,
    subject,
    body,
    authorName,
    authorEmail,
    authorDate,
    files,
    patch
  }
}

export async function gitFullDiffLocal(
  cwd: string,
  opts: { file?: string; staged?: boolean } = {}
): Promise<string> {
  const args = ['diff', opts.staged ? '--cached' : '--']
  if (opts.file) args.push(opts.file)
  const r = await runLocalGitCmd(cwd, args)
  return r.ok ? r.stdout : ''
}

export async function gitFullDiffRemote(
  exec: ExecLike,
  cwd: string,
  opts: { file?: string; staged?: boolean } = {}
): Promise<string> {
  const args = ['diff', opts.staged ? '--cached' : '--']
  if (opts.file) args.push(opts.file)
  const r = await gitRemote(exec, cwd, args)
  return r.ok ? r.stdout : ''
}

export async function gitContributorsLocal(
  cwd: string,
  maxCount = 20
): Promise<GitContributor[]> {
  const r = await runLocalGitCmd(cwd, ['shortlog', '-sn', '-e', `--all`, `-n${maxCount}`])
  if (!r.ok) return []
  return parseShortlog(r.stdout)
}

export async function gitContributorsRemote(
  exec: ExecLike,
  cwd: string,
  maxCount = 20
): Promise<GitContributor[]> {
  const r = await gitRemote(exec, cwd, ['shortlog', '-sn', '-e', '--all', `-n${maxCount}`])
  if (!r.ok) return []
  return parseShortlog(r.stdout)
}

function parseShortlog(stdout: string): GitContributor[] {
  const out: GitContributor[] = []
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue
    // "  42\tName <email@example.com>"
    const m = /^\s*(\d+)\s+(.+?)\s+<([^>]+)>\s*$/.exec(line)
    if (!m) continue
    out.push({ commits: Number(m[1]), name: m[2], email: m[3] })
  }
  return out
}

// ---------------------------------------------------------------------------
// Write-side mutations — thin wrappers around git args. Callers (ipc/git.ts)
// decide whether to run them locally or remotely and pass the resolved cwd /
// exec function. The helpers in this module never take a sessionId so the
// contract stays obvious: "tell git to do this in `cwd`".
// ---------------------------------------------------------------------------

/** Generic args-only mutation. Returns a shared result envelope. */
function localArgs(cwd: string, args: string[], timeoutMs?: number): Promise<GitCommandResult> {
  return runLocalGitCmd(cwd, args, timeoutMs)
}
function remoteArgs(
  exec: ExecLike,
  cwd: string,
  args: string[],
  timeoutMs?: number
): Promise<GitCommandResult> {
  return gitRemote(exec, cwd, args, timeoutMs)
}

/** Switch the working tree to `target`. */
export const gitCheckoutLocal = (cwd: string, args: {
  target: string
  create?: boolean
  force?: boolean
}): Promise<GitCommandResult> => {
  const a = ['checkout']
  if (args.force) a.push('-f')
  if (args.create) a.push('-b')
  a.push(args.target)
  return localArgs(cwd, a)
}

export const gitCheckoutRemote = (
  exec: ExecLike,
  cwd: string,
  args: { target: string; create?: boolean; force?: boolean }
): Promise<GitCommandResult> => {
  const a = ['checkout']
  if (args.force) a.push('-f')
  if (args.create) a.push('-b')
  a.push(args.target)
  return remoteArgs(exec, cwd, a)
}

/** Create a branch (no switch). */
export const gitCreateBranchLocal = (
  cwd: string,
  args: { name: string; from?: string; track?: boolean; force?: boolean }
): Promise<GitCommandResult> => {
  const a = ['branch']
  if (args.force) a.push('-f')
  if (args.track) a.push('--track')
  a.push(args.name)
  if (args.from) a.push(args.from)
  return localArgs(cwd, a)
}

export const gitCreateBranchRemote = (
  exec: ExecLike,
  cwd: string,
  args: { name: string; from?: string; track?: boolean; force?: boolean }
): Promise<GitCommandResult> => {
  const a = ['branch']
  if (args.force) a.push('-f')
  if (args.track) a.push('--track')
  a.push(args.name)
  if (args.from) a.push(args.from)
  return remoteArgs(exec, cwd, a)
}

/** Delete one or more branches. */
export const gitDeleteBranchLocal = (
  cwd: string,
  args: { names: string[]; force?: boolean }
): Promise<GitCommandResult> => localArgs(cwd, ['branch', args.force ? '-D' : '-d', ...args.names])

export const gitDeleteBranchRemote = (
  exec: ExecLike,
  cwd: string,
  args: { names: string[]; force?: boolean }
): Promise<GitCommandResult> =>
  remoteArgs(exec, cwd, ['branch', args.force ? '-D' : '-d', ...args.names])

/** Rename the current (or specified) branch. */
export const gitRenameBranchLocal = (
  cwd: string,
  args: { oldName?: string; newName: string; force?: boolean }
): Promise<GitCommandResult> => {
  const a = ['branch', args.force ? '-M' : '-m']
  if (args.oldName) a.push(args.oldName)
  a.push(args.newName)
  return localArgs(cwd, a)
}

export const gitRenameBranchRemote = (
  exec: ExecLike,
  cwd: string,
  args: { oldName?: string; newName: string; force?: boolean }
): Promise<GitCommandResult> => {
  const a = ['branch', args.force ? '-M' : '-m']
  if (args.oldName) a.push(args.oldName)
  a.push(args.newName)
  return remoteArgs(exec, cwd, a)
}

/** Fetch from a remote. */
export const gitFetchLocal = (
  cwd: string,
  args: { remote?: string; prune?: boolean }
): Promise<GitCommandResult> => {
  const a = ['fetch']
  if (args.prune) a.push('--prune')
  a.push(args.remote || 'origin')
  return localArgs(cwd, a, NETWORK_TIMEOUT_MS)
}

export const gitFetchRemote = (
  exec: ExecLike,
  cwd: string,
  args: { remote?: string; prune?: boolean }
): Promise<GitCommandResult> => {
  const a = ['fetch']
  if (args.prune) a.push('--prune')
  a.push(args.remote || 'origin')
  return remoteArgs(exec, cwd, a, NETWORK_TIMEOUT_MS)
}

/** Pull. */
export const gitPullLocal = (
  cwd: string,
  args: { remote?: string; branch?: string; rebase?: boolean }
): Promise<GitCommandResult> => {
  const a = ['pull']
  if (args.rebase) a.push('--rebase')
  if (args.remote) a.push(args.remote)
  if (args.branch) a.push(args.branch)
  return localArgs(cwd, a, NETWORK_TIMEOUT_MS)
}

export const gitPullRemote = (
  exec: ExecLike,
  cwd: string,
  args: { remote?: string; branch?: string; rebase?: boolean }
): Promise<GitCommandResult> => {
  const a = ['pull']
  if (args.rebase) a.push('--rebase')
  if (args.remote) a.push(args.remote)
  if (args.branch) a.push(args.branch)
  return remoteArgs(exec, cwd, a, NETWORK_TIMEOUT_MS)
}

/** Push. */
export const gitPushLocal = (
  cwd: string,
  args: { remote?: string; branch?: string; setUpstream?: boolean; force?: boolean }
): Promise<GitCommandResult> => {
  const a = ['push']
  if (args.force) a.push('--force-with-lease')
  if (args.setUpstream) a.push('-u')
  a.push(args.remote || 'origin')
  if (args.branch) a.push(args.branch)
  return localArgs(cwd, a, NETWORK_TIMEOUT_MS)
}

export const gitPushRemote = (
  exec: ExecLike,
  cwd: string,
  args: { remote?: string; branch?: string; setUpstream?: boolean; force?: boolean }
): Promise<GitCommandResult> => {
  const a = ['push']
  if (args.force) a.push('--force-with-lease')
  if (args.setUpstream) a.push('-u')
  a.push(args.remote || 'origin')
  if (args.branch) a.push(args.branch)
  return remoteArgs(exec, cwd, a, NETWORK_TIMEOUT_MS)
}

/** Stash apply / drop / pop. */
export const gitStashApplyLocal = (
  cwd: string,
  args: { ref?: string }
): Promise<GitCommandResult> =>
  localArgs(cwd, ['stash', 'apply', args.ref || ''].filter(Boolean))

export const gitStashApplyRemote = (
  exec: ExecLike,
  cwd: string,
  args: { ref?: string }
): Promise<GitCommandResult> =>
  remoteArgs(exec, cwd, ['stash', 'apply', args.ref || ''].filter(Boolean))

export const gitStashDropLocal = (
  cwd: string,
  args: { ref?: string }
): Promise<GitCommandResult> =>
  localArgs(cwd, ['stash', 'drop', args.ref || ''].filter(Boolean))

export const gitStashDropRemote = (
  exec: ExecLike,
  cwd: string,
  args: { ref?: string }
): Promise<GitCommandResult> =>
  remoteArgs(exec, cwd, ['stash', 'drop', args.ref || ''].filter(Boolean))

export const gitStashPopLocal = (
  cwd: string,
  args: { ref?: string }
): Promise<GitCommandResult> =>
  localArgs(cwd, ['stash', 'pop', args.ref || ''].filter(Boolean))

export const gitStashPopRemote = (
  exec: ExecLike,
  cwd: string,
  args: { ref?: string }
): Promise<GitCommandResult> =>
  remoteArgs(exec, cwd, ['stash', 'pop', args.ref || ''].filter(Boolean))

/** Commit. */
export const gitCommitLocal = (
  cwd: string,
  args: { message: string; files?: string[]; amend?: boolean; signOff?: boolean }
): Promise<GitCommandResult> => {
  const a: string[] = []
  if (args.files && args.files.length) {
    a.push('add', '--', ...args.files)
  }
  a.push('commit')
  if (args.amend) a.push('--amend')
  if (args.signOff) a.push('--signoff')
  a.push('-m', args.message)
  return localArgs(cwd, a)
}

export const gitCommitRemote = (
  exec: ExecLike,
  cwd: string,
  args: { message: string; files?: string[]; amend?: boolean; signOff?: boolean }
): Promise<GitCommandResult> => {
  const a: string[] = []
  if (args.files && args.files.length) {
    a.push('add', '--', ...args.files)
  }
  a.push('commit')
  if (args.amend) a.push('--amend')
  if (args.signOff) a.push('--signoff')
  a.push('-m', args.message)
  return remoteArgs(exec, cwd, a)
}

/** Stage / unstage / discard. */
export const gitStageLocal = (cwd: string, files: string[]): Promise<GitCommandResult> =>
  localArgs(cwd, ['add', '--', ...files])

export const gitStageRemote = (
  exec: ExecLike,
  cwd: string,
  files: string[]
): Promise<GitCommandResult> => remoteArgs(exec, cwd, ['add', '--', ...files])

export const gitUnstageLocal = (cwd: string, files: string[]): Promise<GitCommandResult> =>
  localArgs(cwd, ['restore', '--staged', '--', ...files])

export const gitUnstageRemote = (
  exec: ExecLike,
  cwd: string,
  files: string[]
): Promise<GitCommandResult> =>
  remoteArgs(exec, cwd, ['restore', '--staged', '--', ...files])

export const gitDiscardLocal = (cwd: string, files: string[]): Promise<GitCommandResult> =>
  localArgs(cwd, ['restore', '--', ...files])

export const gitDiscardRemote = (
  exec: ExecLike,
  cwd: string,
  files: string[]
): Promise<GitCommandResult> => remoteArgs(exec, cwd, ['restore', '--', ...files])

/** Tag create / delete. */
export const gitTagCreateLocal = (
  cwd: string,
  args: { name: string; ref?: string; message?: string; force?: boolean }
): Promise<GitCommandResult> => {
  const a = ['tag']
  if (args.force) a.push('-f')
  if (args.message) a.push('-a', args.name, '-m', args.message)
  else a.push(args.name)
  if (args.ref) a.push(args.ref)
  return localArgs(cwd, a)
}

export const gitTagCreateRemote = (
  exec: ExecLike,
  cwd: string,
  args: { name: string; ref?: string; message?: string; force?: boolean }
): Promise<GitCommandResult> => {
  const a = ['tag']
  if (args.force) a.push('-f')
  if (args.message) a.push('-a', args.name, '-m', args.message)
  else a.push(args.name)
  if (args.ref) a.push(args.ref)
  return remoteArgs(exec, cwd, a)
}

export const gitTagDeleteLocal = (
  cwd: string,
  names: string[]
): Promise<GitCommandResult> => localArgs(cwd, ['tag', '-d', ...names])

export const gitTagDeleteRemote = (
  exec: ExecLike,
  cwd: string,
  names: string[]
): Promise<GitCommandResult> => remoteArgs(exec, cwd, ['tag', '-d', ...names])

/** Remote add / remove. */
export const gitAddRemoteLocal = (
  cwd: string,
  args: { name: string; url: string }
): Promise<GitCommandResult> => localArgs(cwd, ['remote', 'add', args.name, args.url])

export const gitAddRemoteRemote = (
  exec: ExecLike,
  cwd: string,
  args: { name: string; url: string }
): Promise<GitCommandResult> =>
  remoteArgs(exec, cwd, ['remote', 'add', args.name, args.url])

export const gitRemoveRemoteLocal = (
  cwd: string,
  name: string
): Promise<GitCommandResult> => localArgs(cwd, ['remote', 'remove', name])

export const gitRemoveRemoteRemote = (
  exec: ExecLike,
  cwd: string,
  name: string
): Promise<GitCommandResult> => remoteArgs(exec, cwd, ['remote', 'remove', name])

/** Merge. */
export const gitMergeLocal = (
  cwd: string,
  args: { target: string; noFastForward?: boolean; message?: string }
): Promise<GitCommandResult> => {
  const a = ['merge']
  if (args.noFastForward) a.push('--no-ff')
  if (args.message) a.push('-m', args.message)
  a.push(args.target)
  return localArgs(cwd, a)
}

export const gitMergeRemote = (
  exec: ExecLike,
  cwd: string,
  args: { target: string; noFastForward?: boolean; message?: string }
): Promise<GitCommandResult> => {
  const a = ['merge']
  if (args.noFastForward) a.push('--no-ff')
  if (args.message) a.push('-m', args.message)
  a.push(args.target)
  return remoteArgs(exec, cwd, a)
}
