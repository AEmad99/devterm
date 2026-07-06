// IPC layer for the read-only git module. Two surfaces:
//
//   * `git:status`  — invoke  ; snapshot the current branch + path map.
//   * `git:diff`    — invoke  ; textual diff for one file (best-effort).
//   * `git:on-change:<path>` — main→renderer push; polled on a 5s timer.
//
// Results are cached for 5s per (sessionId, path) so a busy file tree that
// re-asks for the same directory doesn't spawn a fresh git process each frame.
// The poll loop re-uses the same cache: only the first call actually runs git,
// the rest compare against the previous snapshot and only push on change.

import { BrowserWindow, ipcMain } from 'electron'
import { IPC, type GitStatus } from '@shared/types'
import { gitStatusLocal, gitDiffLocal, parsePorcelainFromStdout } from '../git'
import { quoteRemotePath } from '../shell-quote'
import type { SSHManager } from '../ssh/manager'

/** Per-directory cache entry. Expiry is 5s; changed snapshots are returned eagerly. */
interface CacheEntry {
  status: GitStatus
  /** Epoch millis when the snapshot was taken. */
  ts: number
  /** In-flight promise so concurrent callers share one git run. */
  inflight?: Promise<GitStatus>
}

const CACHE_TTL_MS = 5000
const POLL_MS = 5000

const cache = new Map<string, CacheEntry>()

/** Composite cache key — local vs remote paths must not collide. */
function cacheKey(sessionId: string | undefined, path: string): string {
  return sessionId ? `r:${sessionId}:${path}` : `l:${path}`
}

/** Run a one-shot command on an SSH client. Mirrors SSHManager.exec's contract. */
async function resolveLocal(path: string): Promise<GitStatus> {
  return gitStatusLocal(path)
}

async function resolveRemote(ssh: SSHManager, sessionId: string, path: string): Promise<GitStatus> {
  const ctx = ssh.getContext(sessionId)
  if (!ctx) return { isRepo: false, branch: '', ahead: -1, behind: -1, entries: {} }
  // Run git over the session's existing exec channel (SSHManager.exec), so we
  // never open a second connection. The shell-setup path uses the same exec
  // pattern for the OSC 7 probe, so this is the established way to ask the
  // host a one-shot question.
  // Quote the path: it comes from the file explorer's current directory, which
  // follows the remote shell's cwd and can therefore be an attacker-influenced
  // directory name. Plain double quotes do NOT stop `$(...)`/backtick expansion.
  const r = await ssh.exec(
    sessionId,
    `cd ${quoteRemotePath(path)} && git status --porcelain=1 --branch`,
    30000
  )
  if (r.code !== 0) return { isRepo: false, branch: '', ahead: -1, behind: -1, entries: {} }
  return parsePorcelainFromStdout(r.stdout)
}

export function registerGitIpc(ssh: SSHManager, getWindow: () => BrowserWindow | null): void {
  const send = (channel: string, ...args: unknown[]) => {
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
  }

  // `git:status` — return a fresh (or cached) snapshot for the given target.
  ipcMain.handle(IPC.gitStatus, async (_e, target: { sessionId?: string; path: string }) => {
    const key = cacheKey(target.sessionId, target.path)
    const now = Date.now()
    const cur = cache.get(key)
    if (cur && now - cur.ts < CACHE_TTL_MS) return cur.status
    if (cur?.inflight) return cur.inflight
    const inflight = (
      target.sessionId
        ? resolveRemote(ssh, target.sessionId, target.path)
        : resolveLocal(target.path)
    ).finally(() => {
      const e = cache.get(key)
      if (e) delete e.inflight
    })
    cache.set(key, {
      status: { isRepo: false, branch: '', ahead: -1, behind: -1, entries: {} },
      ts: now,
      inflight
    })
    const status = await inflight
    cache.set(key, { status, ts: Date.now() })
    return status
  })

  // `git:diff` — read-only textual diff for a single tracked file. Best-effort;
  // returns an empty string when the file is untracked or git is unavailable.
  ipcMain.handle(
    IPC.gitDiff,
    async (_e, target: { sessionId?: string; path: string; file: string }) => {
      if (target.sessionId) {
        // Both the directory and the filename are untrusted; quote both with the
        // POSIX-safe escaper rather than the old double-quote-only form (which
        // left `$()`/backticks live).
        const r = await ssh.exec(
          target.sessionId,
          `cd ${quoteRemotePath(target.path)} && git diff -- ${quoteRemotePath(target.file)}`,
          30000
        )
        return r.code === 0 ? r.stdout : ''
      }
      return gitDiffLocal(target.path, target.file)
    }
  )

  // `git:on-change:<path>` — main → renderer push channel. The IPC name itself
  // carries the working directory so the renderer can subscribe by path with
  // a tiny on() wrapper; the actual subscription bookkeeping lives here.
  //
  // Implementation: a single setInterval polls every 5s for the *currently
  // tracked* paths. The first time a path is asked for, snapshot it eagerly
  // and push. Subsequent ticks only push when the status object changed.
  const watched = new Set<string>()
  const lastPushed = new Map<string, string>()
  const interval = setInterval(() => void tick(), POLL_MS)
  const tick = async () => {
    if (watched.size === 0) return
    for (const key of [...watched]) {
      const [scope, sidRaw, ...rest] = key.split(':')
      // sessionId (when present) is one segment; path can contain colons on
      // Windows ("C:...") so we rejoin from the right.
      const path = rest.join(':')
      const sessionId = scope === 'r' ? sidRaw : undefined
      try {
        const next = sessionId
          ? await resolveRemote(ssh, sessionId, path)
          : await resolveLocal(path)
        const sig = signature(next)
        if (lastPushed.get(key) !== sig) {
          lastPushed.set(key, sig)
          // Push on the session-scoped key (matches the preload subscription).
          // Using path-only here let a local repo's updates land on a remote
          // repo's listener at the same path, and vice versa.
          send(`${IPC.gitOnChange}:${key}`, next)
        }
      } catch {
        /* ignore — git is best-effort */
      }
    }
  }
  // Renderer signals "watch this path" by invoking `status` with the same path
  // (the cache is keyed on the path). We piggy-back by adding to `watched`
  // on every status call, and pruning anything that hasn't been asked for in
  // a while. To keep it simple we also accept an explicit add via the same
  // handle — the renderer's git.onChange() wrapper handles subscription.
  ipcMain.handle(`${IPC.gitOnChange}:add`, (_e, target: { sessionId?: string; path: string }) => {
    watched.add(cacheKey(target.sessionId, target.path))
    return true
  })
  ipcMain.handle(
    `${IPC.gitOnChange}:remove`,
    (_e, target: { sessionId?: string; path: string }) => {
      const k = cacheKey(target.sessionId, target.path)
      watched.delete(k)
      lastPushed.delete(k)
      return true
    }
  )

  // Clear the polling timer on app quit; the main process tears the ipcMain
  // down for us, but a stray setInterval would keep this process alive.
  const cleanup = () => clearInterval(interval)
  process.once('before-quit', cleanup)
}

/** Cheap signature so the poll loop doesn't push redundant snapshots. */
function signature(s: GitStatus): string {
  return [
    s.isRepo ? '1' : '0',
    s.branch,
    s.ahead,
    s.behind,
    s.truncated ? '1' : '0',
    Object.keys(s.entries).length,
    // The full map is small enough to inline; cheaper than JSON.stringify.
    Object.entries(s.entries)
      .map(([p, st]) => `${st}:${p}`)
      .join('|')
  ].join(';')
}
