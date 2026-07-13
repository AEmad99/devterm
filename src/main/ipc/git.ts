// IPC layer for the git module. Two surfaces:
//
//   * `git:*` invoke/push channels: branch, remote, log, stash, tag, fileAt,
//     blame, show, fullDiff, contributors, and the write-side mutations
//     (checkout, branch create/delete/rename, fetch/pull/push, stash apply/
//     drop/pop, commit, stage/unstage/discard, tag create/delete, remote add/
//     remove, merge).
//   * `git:on-change:<path>` — main→renderer push; polled on a 5s timer.
//
// Results are cached for 5s per (sessionId, path) so a busy file tree that
// re-asks for the same directory doesn't spawn a fresh git process each frame.
// The poll loop re-uses the same cache: only the first call actually runs git,
// the rest compare against the previous snapshot and only push on change.
//
// Every operation takes `{ sessionId?, path, ... }`. Local paths omit the
// sessionId; remote paths run over the SSHManager's existing exec channel
// (never a new ssh connection).

import { BrowserWindow, ipcMain } from 'electron'
import { IPC } from '@shared/types'
import type {
  GitBlameLine,
  GitBranches,
  GitCommandResult,
  GitContributor,
  GitLogEntry,
  GitRemote,
  GitShowResult,
  GitStashEntry,
  GitStatus,
  GitTag
} from '@shared/types'
import * as git from '../git'
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

async function resolveLocal(path: string): Promise<GitStatus> {
  return git.gitStatusLocal(path)
}

async function resolveRemote(ssh: SSHManager, sessionId: string, path: string): Promise<GitStatus> {
  const ctx = ssh.getContext(sessionId)
  if (!ctx) return { isRepo: false, branch: '', ahead: -1, behind: -1, entries: {} }
  const r = await ssh.exec(
    sessionId,
    `cd ${gitExecPath(path)} && git status --porcelain=1 --branch`,
    30000
  )
  if (r.code !== 0) return { isRepo: false, branch: '', ahead: -1, behind: -1, entries: {} }
  return git.parsePorcelainFromStdout(r.stdout)
}

/** Single-quote a path for safe interpolation into a remote shell command. */
function gitExecPath(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`
}

/**
 * Adapt `ssh.exec(sessionId, cmd, timeoutMs)` to the `(cmd, timeoutMs) => …`
 * signature the `../git` helpers expect. Caller must guarantee `sessionId` is
 * defined (the helpers are only called when `target.sessionId` is present).
 */
function execFor(ssh: SSHManager, sessionId: string) {
  return (cmd: string, timeoutMs = 30000) => ssh.exec(sessionId, cmd, timeoutMs)
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

  // `git:diff` — read-only textual diff for a single tracked file.
  ipcMain.handle(
    IPC.gitDiff,
    async (_e, target: { sessionId?: string; path: string; file: string }) => {
      if (target.sessionId) {
        const r = await ssh.exec(
          target.sessionId,
          `cd ${gitExecPath(target.path)} && git diff -- ${gitExecPath(target.file)}`,
          30000
        )
        return r.code === 0 ? r.stdout : ''
      }
      return git.gitDiffLocal(target.path, target.file)
    }
  )

  // ---------------------------------------------------------------------
  // Read-side additions
  // ---------------------------------------------------------------------

  ipcMain.handle(IPC.gitBranches, async (_e, target: { sessionId?: string; path: string }) => {
    if (target.sessionId) return git.gitBranchesRemote(execFor(ssh, target.sessionId), target.path)
    return git.gitBranchesLocal(target.path)
  })

  ipcMain.handle(IPC.gitRemotes, async (_e, target: { sessionId?: string; path: string }) => {
    if (target.sessionId) return git.gitRemotesRemote(execFor(ssh, target.sessionId), target.path)
    return git.gitRemotesLocal(target.path)
  })

  ipcMain.handle(
    IPC.gitLog,
    async (
      _e,
      target: { sessionId?: string; path: string; maxCount?: number; ref?: string; file?: string }
    ): Promise<GitLogEntry[]> => {
      if (target.sessionId)
        return git.gitLogRemote(execFor(ssh, target.sessionId), target.path, {
          maxCount: target.maxCount,
          ref: target.ref,
          file: target.file
        })
      return git.gitLogLocal(target.path, {
        maxCount: target.maxCount,
        ref: target.ref,
        file: target.file
      })
    }
  )

  ipcMain.handle(
    IPC.gitStash,
    async (_e, target: { sessionId?: string; path: string }): Promise<GitStashEntry[]> => {
      if (target.sessionId)
        return git.gitStashListRemote(execFor(ssh, target.sessionId), target.path)
      return git.gitStashListLocal(target.path)
    }
  )

  ipcMain.handle(
    IPC.gitTags,
    async (_e, target: { sessionId?: string; path: string }): Promise<GitTag[]> => {
      if (target.sessionId)
        return git.gitTagsRemote(execFor(ssh, target.sessionId), target.path)
      return git.gitTagsLocal(target.path)
    }
  )

  ipcMain.handle(
    IPC.gitFileAt,
    async (_e, target: { sessionId?: string; path: string; file: string; ref?: string }) => {
      if (target.sessionId)
        return git.gitFileAtRemote(execFor(ssh, target.sessionId), target.path, target.file, target.ref)
      return git.gitFileAtLocal(target.path, target.file, target.ref)
    }
  )

  ipcMain.handle(
    IPC.gitBlame,
    async (_e, target: { sessionId?: string; path: string; file: string }): Promise<GitBlameLine[]> => {
      if (target.sessionId)
        return git.gitBlameRemote(execFor(ssh, target.sessionId), target.path, target.file)
      return git.gitBlameLocal(target.path, target.file)
    }
  )

  ipcMain.handle(
    IPC.gitShow,
    async (
      _e,
      target: { sessionId?: string; path: string; sha: string }
    ): Promise<GitShowResult | null> => {
      if (target.sessionId)
        return git.gitShowRemote(execFor(ssh, target.sessionId), target.path, target.sha)
      return git.gitShowLocal(target.path, target.sha)
    }
  )

  ipcMain.handle(
    IPC.gitFullDiff,
    async (_e, target: { sessionId?: string; path: string; file?: string; staged?: boolean }) => {
      if (target.sessionId)
        return git.gitFullDiffRemote(execFor(ssh, target.sessionId), target.path, {
          file: target.file,
          staged: target.staged
        })
      return git.gitFullDiffLocal(target.path, { file: target.file, staged: target.staged })
    }
  )

  ipcMain.handle(
    IPC.gitContributors,
    async (
      _e,
      target: { sessionId?: string; path: string; maxCount?: number }
    ): Promise<GitContributor[]> => {
      if (target.sessionId)
        return git.gitContributorsRemote(
          execFor(ssh, target.sessionId),
          target.path,
          target.maxCount ?? 20
        )
      return git.gitContributorsLocal(target.path, target.maxCount ?? 20)
    }
  )

  // ---------------------------------------------------------------------
  // Write-side mutations
  // ---------------------------------------------------------------------

  ipcMain.handle(
    IPC.gitCheckout,
    async (
      _e,
      target: {
        sessionId?: string
        path: string
        target: string
        create?: boolean
        force?: boolean
      }
    ): Promise<GitCommandResult> => {
      const r = target.sessionId
        ? await git.gitCheckoutRemote(execFor(ssh, target.sessionId), target.path, {
            target: target.target,
            create: target.create,
            force: target.force
          })
        : await git.gitCheckoutLocal(target.path, {
            target: target.target,
            create: target.create,
            force: target.force
          })
      invalidate(target)
      return r
    }
  )

  ipcMain.handle(
    IPC.gitCreateBranch,
    async (
      _e,
      target: {
        sessionId?: string
        path: string
        name: string
        from?: string
        track?: boolean
        force?: boolean
      }
    ): Promise<GitCommandResult> => {
      const r = target.sessionId
        ? await git.gitCreateBranchRemote(execFor(ssh, target.sessionId), target.path, target)
        : await git.gitCreateBranchLocal(target.path, target)
      invalidate(target)
      return r
    }
  )

  ipcMain.handle(
    IPC.gitDeleteBranch,
    async (
      _e,
      target: { sessionId?: string; path: string; names: string[]; force?: boolean }
    ): Promise<GitCommandResult> => {
      const r = target.sessionId
        ? await git.gitDeleteBranchRemote(execFor(ssh, target.sessionId), target.path, target)
        : await git.gitDeleteBranchLocal(target.path, target)
      invalidate(target)
      return r
    }
  )

  ipcMain.handle(
    IPC.gitRenameBranch,
    async (
      _e,
      target: {
        sessionId?: string
        path: string
        oldName?: string
        newName: string
        force?: boolean
      }
    ): Promise<GitCommandResult> => {
      const r = target.sessionId
        ? await git.gitRenameBranchRemote(execFor(ssh, target.sessionId), target.path, target)
        : await git.gitRenameBranchLocal(target.path, target)
      invalidate(target)
      return r
    }
  )

  ipcMain.handle(
    IPC.gitFetch,
    async (_e, target: { sessionId?: string; path: string; remote?: string; prune?: boolean }) => {
      const r = target.sessionId
        ? await git.gitFetchRemote(execFor(ssh, target.sessionId), target.path, target)
        : await git.gitFetchLocal(target.path, target)
      invalidate(target)
      return r
    }
  )

  ipcMain.handle(
    IPC.gitPull,
    async (
      _e,
      target: {
        sessionId?: string
        path: string
        remote?: string
        branch?: string
        rebase?: boolean
      }
    ) => {
      const r = target.sessionId
        ? await git.gitPullRemote(execFor(ssh, target.sessionId), target.path, target)
        : await git.gitPullLocal(target.path, target)
      invalidate(target)
      return r
    }
  )

  ipcMain.handle(
    IPC.gitPush,
    async (
      _e,
      target: {
        sessionId?: string
        path: string
        remote?: string
        branch?: string
        setUpstream?: boolean
        force?: boolean
      }
    ) => {
      const r = target.sessionId
        ? await git.gitPushRemote(execFor(ssh, target.sessionId), target.path, target)
        : await git.gitPushLocal(target.path, target)
      invalidate(target)
      return r
    }
  )

  ipcMain.handle(
    IPC.gitStashApply,
    async (_e, target: { sessionId?: string; path: string; ref?: string }) => {
      const r = target.sessionId
        ? await git.gitStashApplyRemote(execFor(ssh, target.sessionId), target.path, target)
        : await git.gitStashApplyLocal(target.path, target)
      invalidate(target)
      return r
    }
  )

  ipcMain.handle(
    IPC.gitStashDrop,
    async (_e, target: { sessionId?: string; path: string; ref?: string }) => {
      const r = target.sessionId
        ? await git.gitStashDropRemote(execFor(ssh, target.sessionId), target.path, target)
        : await git.gitStashDropLocal(target.path, target)
      invalidate(target)
      return r
    }
  )

  ipcMain.handle(
    IPC.gitStashPop,
    async (_e, target: { sessionId?: string; path: string; ref?: string }) => {
      const r = target.sessionId
        ? await git.gitStashPopRemote(execFor(ssh, target.sessionId), target.path, target)
        : await git.gitStashPopLocal(target.path, target)
      invalidate(target)
      return r
    }
  )

  ipcMain.handle(
    IPC.gitCommit,
    async (
      _e,
      target: {
        sessionId?: string
        path: string
        message: string
        files?: string[]
        amend?: boolean
        signOff?: boolean
      }
    ) => {
      const r = target.sessionId
        ? await git.gitCommitRemote(execFor(ssh, target.sessionId), target.path, target)
        : await git.gitCommitLocal(target.path, target)
      invalidate(target)
      return r
    }
  )

  ipcMain.handle(
    IPC.gitStage,
    async (_e, target: { sessionId?: string; path: string; files: string[] }) => {
      const r = target.sessionId
        ? await git.gitStageRemote(execFor(ssh, target.sessionId), target.path, target.files)
        : await git.gitStageLocal(target.path, target.files)
      invalidate(target)
      return r
    }
  )

  ipcMain.handle(
    IPC.gitUnstage,
    async (_e, target: { sessionId?: string; path: string; files: string[] }) => {
      const r = target.sessionId
        ? await git.gitUnstageRemote(execFor(ssh, target.sessionId), target.path, target.files)
        : await git.gitUnstageLocal(target.path, target.files)
      invalidate(target)
      return r
    }
  )

  ipcMain.handle(
    IPC.gitDiscard,
    async (_e, target: { sessionId?: string; path: string; files: string[] }) => {
      const r = target.sessionId
        ? await git.gitDiscardRemote(execFor(ssh, target.sessionId), target.path, target.files)
        : await git.gitDiscardLocal(target.path, target.files)
      invalidate(target)
      return r
    }
  )

  ipcMain.handle(
    IPC.gitTagCreate,
    async (
      _e,
      target: {
        sessionId?: string
        path: string
        name: string
        ref?: string
        message?: string
        force?: boolean
      }
    ) => {
      const r = target.sessionId
        ? await git.gitTagCreateRemote(execFor(ssh, target.sessionId), target.path, target)
        : await git.gitTagCreateLocal(target.path, target)
      invalidate(target)
      return r
    }
  )

  ipcMain.handle(
    IPC.gitTagDelete,
    async (_e, target: { sessionId?: string; path: string; names: string[] }) => {
      const r = target.sessionId
        ? await git.gitTagDeleteRemote(execFor(ssh, target.sessionId), target.path, target.names)
        : await git.gitTagDeleteLocal(target.path, target.names)
      invalidate(target)
      return r
    }
  )

  ipcMain.handle(
    IPC.gitAddRemote,
    async (_e, target: { sessionId?: string; path: string; name: string; url: string }) => {
      const r = target.sessionId
        ? await git.gitAddRemoteRemote(execFor(ssh, target.sessionId), target.path, target)
        : await git.gitAddRemoteLocal(target.path, target)
      invalidate(target)
      return r
    }
  )

  ipcMain.handle(
    IPC.gitRemoveRemote,
    async (_e, target: { sessionId?: string; path: string; name: string }) => {
      const r = target.sessionId
        ? await git.gitRemoveRemoteRemote(execFor(ssh, target.sessionId), target.path, target.name)
        : await git.gitRemoveRemoteLocal(target.path, target.name)
      invalidate(target)
      return r
    }
  )

  ipcMain.handle(
    IPC.gitMerge,
    async (
      _e,
      target: {
        sessionId?: string
        path: string
        target: string
        noFastForward?: boolean
        message?: string
      }
    ) => {
      const r = target.sessionId
        ? await git.gitMergeRemote(execFor(ssh, target.sessionId), target.path, target)
        : await git.gitMergeLocal(target.path, target)
      invalidate(target)
      return r
    }
  )

  // ---------------------------------------------------------------------
  // Live status push (unchanged behavior)
  // ---------------------------------------------------------------------

  const watched = new Set<string>()
  const lastPushed = new Map<string, string>()
  const interval = setInterval(() => void tick(), POLL_MS)
  const tick = async () => {
    if (watched.size === 0) return
    for (const key of [...watched]) {
      const [scope, sidRaw, ...rest] = key.split(':')
      const path = rest.join(':')
      const sessionId = scope === 'r' ? sidRaw : undefined
      try {
        const next = sessionId
          ? await resolveRemote(ssh, sessionId, path)
          : await resolveLocal(path)
        const sig = signature(next)
        if (lastPushed.get(key) !== sig) {
          lastPushed.set(key, sig)
          send(`${IPC.gitOnChange}:${key}`, next)
        }
      } catch {
        /* ignore — git is best-effort */
      }
    }
  }
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

  const cleanup = () => clearInterval(interval)
  process.once('before-quit', cleanup)

  /** Force the next status call for `target` to re-run git (used after writes). */
  function invalidate(target: { sessionId?: string; path: string }) {
    cache.delete(cacheKey(target.sessionId, target.path))
  }
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
    Object.entries(s.entries)
      .map(([p, st]) => `${st}:${p}`)
      .join('|')
  ].join(';')
}

// Re-export the read-side and write-side result types so this module is the
// single source of truth for IPC channel wiring. Unused in production but
// helpful for typed callers.
export type { GitBranches, GitRemote, GitLogEntry, GitStashEntry, GitTag }
