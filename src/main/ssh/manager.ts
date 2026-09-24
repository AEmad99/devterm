import { randomUUID } from 'crypto'
import type { Client, ClientChannel, SFTPWrapper } from 'ssh2'
import type {
  HostContext,
  SSHConnectResult,
  SSHOpenShellOptions,
  SSHProfile,
  SSHStatus,
  TmuxAttachRequest,
  TmuxListing
} from '@shared/types'
import { establish } from './connection'
import { createExecGate, POSIX_EXEC_SLOTS } from './exec-gate'
import { establishProfile } from './auth'
import { detectRemoteContext } from './osDetect'
import { PortForwardManager } from './port-forward'
import {
  normalizeWindowsInteractiveInput,
  windowsPowerShellInteractiveCommand
} from './windows-host'
import {
  TMUX_CLIENT_LEFT_RE,
  TMUX_LIST_CLIENTS,
  TMUX_PROBE_AND_LIST,
  buildTmuxAttachCommand,
  buildTmuxDetachClientCommand,
  buildTmuxEnsureSessionCommand,
  buildTmuxKillCommand,
  buildTmuxSwitchCommand,
  isTmuxSessionGone,
  parseTmuxClients,
  parseTmuxListing,
  pickClientTty
} from './tmux'

export { buildDetachedSessionBootstrap } from './tmux'

function endTunnel(jump?: Client, jumps?: Client[]): void {
  const seen = new Set<Client>()
  for (const c of [jump, ...(jumps ?? [])]) {
    if (!c || seen.has(c)) continue
    seen.add(c)
    try {
      c.end()
    } catch {
      /* ignore */
    }
  }
}

interface Session {
  id: string
  /**
   * Live ssh2 client, or undefined while a reconnect placeholder is in
   * effect (transport down). Callers must treat undefined as "session
   * reconnecting" rather than "unknown session".
   */
  client?: Client
  jump?: Client
  jumps?: Client[]
  execJumps?: Client[]
  sftpJumps?: Client[]
  forwardJumps?: Client[]
  /**
   * Windows OpenSSH compatibility clients. Some Windows SSH servers advertise
   * a shell but reset the whole transport when a second channel is opened on
   * that connection. Keep the operator's interactive channel on `client` and
   * use one command-only connection plus one SFTP-only connection instead.
   */
  execClient?: Client
  execJump?: Client
  execClientInflight?: Promise<Client>
  execQueue?: Promise<void>
  /** Caps parallel exec channels on the primary client (POSIX MaxSessions). */
  execGate?: ReturnType<typeof createExecGate>
  sftpClient?: Client
  sftpJump?: Client
  sftpClientInflight?: Promise<Client>
  forwardClient?: Client
  forwardJump?: Client
  forwardClientInflight?: Promise<Client>
  forwardRefs?: number
  forwardIdleTimer?: NodeJS.Timeout
  shell?: ClientChannel
  /** Last requested terminal channel, retained across transport reconnects. */
  shellRequest?: ShellRequest
  /**
   * Streaming UTF-8 decoder for the shell channel. ssh2 emits data in
   * arbitrary byte boundaries, and a multi-byte UTF-8 codepoint split across
   * two `data` events decodes to U+FFFD if each chunk is `.toString()`'d on
   * its own. Feeding every chunk through one `TextDecoder` with
   * `{ stream: true }` carries the partial sequence across the boundary so
   * box-drawing, emoji, and accented filenames render correctly in the
   * terminal. One decoder covers stdout and stderr together (they merge into
   * the same visible stream and ssh2 emits them in byte order).
   */
  shellDecoder?: TextDecoder
  sftp?: SFTPWrapper
  /** In-flight SFTP open; concurrent getSftp callers share this promise. */
  sftpInflight?: Promise<SFTPWrapper>
  /** In-flight shell open; concurrent openShell callers share this promise. */
  shellInflight?: Promise<void>
  /** Coalesces recovery when only the Windows interactive channel closes. */
  shellRecoveryTimer?: NodeJS.Timeout
  /** Bounded recovery attempts for repeatedly dropped Windows shell channels. */
  shellRecoveryAttempts?: number
  shellRecoveryWindowStartedAt?: number
  /** Coalesces shell-channel and transport close into one renderer exit event. */
  exitReported?: boolean
  context: HostContext
  /**
   * The original profile the session was opened with. Kept so the
   * auto-reconnect loop can re-issue `establish` with the same auth/host
   * without the renderer having to remember the password.
   */
  profile: SSHProfile
  /** Active reconnect loop, if any. Set by the manager when scheduling a retry. */
  reconnect?: ReconnectState
  /** Pending shell-setup write timers; cleared on disconnect. */
  setupTimers?: Set<NodeJS.Timeout>
  /**
   * True while we are waiting for the login banner / MOTD to finish before
   * quietly injecting POSIX shell-integration. Cleared once the inject fires
   * or setup is cancelled (tmux attach, disconnect).
   */
  shellIntegrationPending?: boolean
  /** Re-arms the MOTD-idle timer; set only while `shellIntegrationPending`. */
  shellIntegrationArmIdle?: () => void
  /**
   * True while `disconnect()` is tearing the session down. Shell-channel
   * close must not auto-reopen a login shell in that window.
   */
  closing?: boolean
  /** True between writing `tmux attach` and a confirmed return to the login shell. */
  tmuxClientRunning?: boolean
  /** Coalesces detach-banner + channel-close into one resume attempt. */
  tmuxResumeTimer?: NodeJS.Timeout
}

const RECONNECTING_ERR = 'session reconnecting'

interface ReconnectState {
  /** Timer for the next attempt; cleared when the loop is cancelled. */
  timer: NodeJS.Timeout
  /** Prevent overlapping attempts when reconnect is triggered repeatedly. */
  running?: boolean
  /** How many attempts have been made so far. */
  attempt: number
  /** Effective max attempts from the policy at loop start. */
  maxAttempts: number
  /** Backoff policy in effect for this loop. */
  policy: ReconnectPolicy
  /** Last error from a failed attempt; surfaced on permanent failure. */
  lastError?: string
  /** True if the user explicitly asked for a retry after permanent failure. */
  userInitiated?: boolean
  /** Human-shell configuration to restore after the SSH transport returns. */
  shellRequest?: ShellRequest
}

interface ShellRequest {
  cols: number
  rows: number
  detached: boolean
  /** Last tmux session the operator attached to; restored after SSH reconnect. */
  tmuxSession?: string
}

export interface ReconnectPolicy {
  /** Master switch — when off, drops are terminal. */
  enabled: boolean
  /** Max attempts (including the first retry) before giving up. */
  maxAttempts: number
  /** Initial delay before the first retry, in ms. */
  baseDelayMs: number
  /** Cap for any single delay, in ms (the backoff is clamped here). */
  maxDelayMs: number
  /** Multiplier per attempt. 1 = constant delay, 2 = classic exponential. */
  factor: number
}

export const DEFAULT_RECONNECT_POLICY: ReconnectPolicy = {
  enabled: true,
  maxAttempts: 5,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  factor: 2
}

/**
 * One-liner injected into a remote POSIX shell after open so DevTerm can track
 * cwd (OSC 7) and command-input anchors (OSC 133 ;A/;B).
 *
 * Inside tmux, bare OSC sequences are consumed for pane metadata and never
 * reach the outer terminal. When `$TMUX` is set we:
 *  1. enable `allow-passthrough` on the current session (best-effort), and
 *  2. wrap each OSC in the DCS form `\ePtmux;\e<esc-doubled-payload>\e\\`
 * so xterm.js still sees OSC 7 / 133 and the file explorer follows `cd`.
 *
 * After install, the script restores echo and reclaims leftover rows from the
 * quiet inject (see `SHELL_INTEGRATION_RECLAIM_LINES`) instead of `clear`.
 */

/**
 * Rows the POSIX inject must reclaim after writeQuiet. Matches the blank
 * lines left under the login prompt when echo is off (command text hidden,
 * newlines still committed).
 */
export const SHELL_INTEGRATION_RECLAIM_LINES = 3

/**
 * How long shell output must stay quiet before we treat the login MOTD as
 * finished and inject OSC hooks. Long banners (Bazzite, Fedora Silverblue,
 * some cloud images) print for well over the old fixed 250ms delay; injecting
 * during that window left `stty -echo` / a failed script with echo off so
 * typed characters never appeared.
 */
export const SHELL_INTEGRATION_IDLE_MS = 450

/** Cap waiting for MOTD idle — still inject so hooks eventually land. */
export const SHELL_INTEGRATION_MAX_WAIT_MS = 8000

/**
 * After writeQuiet disables echo for the inject, nudge it back on in case the
 * setup one-liner never ran (or died before its trailing `stty echo`).
 */
const ECHO_RESTORE_FAILSAFE_MS = 1200

export function buildPosixShellIntegrationSetup(): string {
  // DCS-wrapped OSC payloads: every ESC in the inner sequence is doubled.
  // BEL (`\007`) is left as-is. Terminator is ESC \ (ST).
  const osc7Tmux = `printf '\\033Ptmux;\\033\\033]7;file://%s%s\\007\\033\\\\' "\${HOSTNAME:-h}" "$PWD"`
  const osc7Plain = `printf '\\033]7;file://%s%s\\007' "\${HOSTNAME:-h}" "$PWD"`
  const osc133ATmux = `printf '\\033Ptmux;\\033\\033]133;A\\007\\033\\\\'`
  const osc133BTmux = `printf '\\033Ptmux;\\033\\033]133;B\\007\\033\\\\'`
  const osc133APlain = `printf '\\033]133;A\\007'`
  const osc133BPlain = `printf '\\033]133;B\\007'`

  return (
    // Echo is already off for this one-liner (writeQuiet's `stty -echo`).
    // Do not `clear` — that wiped the login banner after the inject flashed.
    `[ -n "\${TMUX-}" ] && tmux set-option allow-passthrough on 2>/dev/null; ` +
    `__dt7() { ` +
    `if [ -n "\${TMUX-}" ]; then ${osc7Tmux}; ` +
    `else ${osc7Plain}; fi; }; ` +
    `if [ -n "\${TMUX-}" ]; then ` +
    `__dtA=$(${osc133ATmux}); __dtB=$(${osc133BTmux}); ` +
    `else ` +
    `__dtA=$(${osc133APlain}); __dtB=$(${osc133BPlain}); ` +
    `fi; ` +
    `if [ -n "$ZSH_VERSION" ]; then ` +
    `case " \${precmd_functions[*]} " in *" __dt7 "*) ;; *) precmd_functions+=(__dt7);; esac; ` +
    // When under tmux, only treat the prompt as already integrated if it has
    // the DCS wrap (Ptmux). A bare OSC 133 from a pre-fix session is replaced
    // so autosuggest anchors still reach the outer terminal.
    `if [ -n "\${TMUX-}" ]; then case "$PROMPT" in *Ptmux*133*) ;; *) PROMPT="%{$__dtA%}$PROMPT%{$__dtB%}";; esac; ` +
    `else case "$PROMPT" in *133*) ;; *) PROMPT="%{$__dtA%}$PROMPT%{$__dtB%}";; esac; fi; ` +
    `else ` +
    `case ":$PROMPT_COMMAND:" in *__dt7*) ;; *) PROMPT_COMMAND="__dt7\${PROMPT_COMMAND:+;$PROMPT_COMMAND}";; esac; ` +
    `if [ -n "$BASH_VERSION" ]; then ` +
    // bash resolves the zero-width `\[`/`\]` markers on the literal PS1 text
    // before expanding ${var} references. Baking the OSC bytes straight in
    // (PS1="\[$__dtA\]…") lets the tmux DCS-wrapped marker's terminator backslash
    // (`ESC \`) collide with the closing `\]`, which bash turns into a literal
    // `\\]` — a stray `]` printed around the prompt. Referencing ${__dtA} defers
    // the injection until after `\[`/`\]` are bound, keeping the prompt clean.
    `case "$PS1" in *'\${__dtA}'*) ;; *) PS1='\\[\${__dtA}\\]'"$PS1"'\\[\${__dtB}\\]';; esac; fi; ` +
    `fi; ` +
    // Restore echo, then eat leftover rows from the quiet inject. writeQuiet
    // submits `stty -echo` and this payload as two commands; with echo off the
    // text is hidden but the newlines still land (typically three blank rows
    // under the login prompt). Do not `clear` — that wipes the MOTD. The next
    // prompt runs `__dt7` via PROMPT_COMMAND / precmd, so do not call it here
    // (it would print OSC 7 on a row we are about to delete).
    `stty echo 2>/dev/null; printf '\\033[${SHELL_INTEGRATION_RECLAIM_LINES}A\\r\\033[J'\n`
  )
}

/** First half of a quiet inject: turn off PTY echo (this line itself may flash). */
export const STTY_DISABLE_ECHO = '\x15stty -echo 2>/dev/null\n'

/** Failsafe / post-tmux restore so operator typing is always visible. */
export const STTY_ENABLE_ECHO = '\x15stty echo 2>/dev/null\n'

/** Wait for `stty -echo` to run before sending the payload on a slow SSH link. */
const QUIET_WRITE_GAP_MS = 180

export interface SSHHandlers {
  onData: (sessionId: string, data: string) => void
  onExit: (sessionId: string) => void
  onStatus: (sessionId: string, status: SSHStatus) => void
  /** Fires when an explicit disconnect removes a session from the manager. */
  onDispose?: (sessionId: string) => void
}

/** Listener registered via `addStatusListener`; called for every status event. */
export type SSHStatusListener = (status: SSHStatus) => void

/**
 * Owns SSH sessions. The normal path uses one ssh2 client per session, with
 * the human shell, SFTP, and MCP bridge sharing its channels. Windows
 * OpenSSH compatibility mode is the deliberate exception: servers with a
 * one-channel limit get isolated command-only and SFTP-only clients so an
 * agent command cannot reset the operator's interactive shell.
 */
export class SSHManager {
  private sessions = new Map<string, Session>()
  /** Active reconnect policy; mutated by the renderer via `setReconnectPolicy`. */
  private policy: ReconnectPolicy = { ...DEFAULT_RECONNECT_POLICY }
  /**
   * Extra per-process status listeners (the agent bridge subscribes here so
   * it can pause tools and surface a reconnecting status when SSH drops).
   * Registered via {@link addStatusListener}; fired alongside the primary
   * `handlers.onStatus` from {@link fireStatus}.
   */
  private statusListeners = new Map<string, Set<SSHStatusListener>>()
  /** Port forwards bound to live SSH sessions. */
  forwardManager = new PortForwardManager(
    (sessionId) => Boolean(this.sessions.get(sessionId)?.client),
    (sessionId) => this.acquirePortForwardClient(sessionId)
  )

  constructor(private handlers: SSHHandlers) {}

  private async acquirePortForwardClient(
    sessionId: string
  ): Promise<{ client: Client; release?: () => void } | undefined> {
    const s = this.sessions.get(sessionId)
    if (!s?.client || s.closing || s.reconnect) return undefined
    if (s.context.os !== 'windows') return { client: s.client }

    const client = await this.ensureWindowsForwardClient(sessionId)
    if (this.sessions.get(sessionId) !== s || s.forwardClient !== client) return undefined
    if (s.forwardIdleTimer) {
      clearTimeout(s.forwardIdleTimer)
      s.forwardIdleTimer = undefined
    }
    s.forwardRefs = (s.forwardRefs ?? 0) + 1
    let released = false
    return {
      client,
      release: () => {
        if (released) return
        released = true
        if (s.forwardClient !== client) return
        s.forwardRefs = Math.max(0, (s.forwardRefs ?? 1) - 1)
        if (s.forwardRefs > 0 || s.forwardIdleTimer) return
        s.forwardIdleTimer = setTimeout(() => {
          s.forwardIdleTimer = undefined
          if (s.forwardClient === client && !s.forwardRefs) this.closeWindowsForwardClient(s)
        }, 30_000)
      }
    }
  }

  /**
   * Subscribe to status events for a single SSH session. Returns a disposer.
   * The agent IPC uses this to learn about `closed` / `reconnecting` /
   * `reconnected` so tool calls can return a clear "retry shortly" message
   * instead of the generic "unknown session" the disconnected session
   * previously surfaced (the symptom that made the agent give up and crash).
   */
  addStatusListener(sessionId: string, cb: SSHStatusListener): () => void {
    let set = this.statusListeners.get(sessionId)
    if (!set) {
      set = new Set()
      this.statusListeners.set(sessionId, set)
    }
    set.add(cb)
    return () => {
      const s = this.statusListeners.get(sessionId)
      if (!s) return
      s.delete(cb)
      if (s.size === 0) this.statusListeners.delete(sessionId)
    }
  }

  /** Central status dispatch — fires the primary handler AND every per-session listener. */
  private fireStatus(sessionId: string, status: SSHStatus): void {
    this.handlers.onStatus(sessionId, status)
    const set = this.statusListeners.get(sessionId)
    if (!set) return
    for (const cb of set) {
      try {
        cb(status)
      } catch (err) {
        console.error('[ssh] status listener threw:', err)
      }
    }
  }

  /** Update the auto-reconnect policy in effect for future drops. */
  setReconnectPolicy(patch: Partial<ReconnectPolicy>): void {
    this.policy = { ...this.policy, ...patch }
  }

  getReconnectPolicy(): ReconnectPolicy {
    return { ...this.policy }
  }

  getProfile(sessionId: string): SSHProfile | undefined {
    return this.sessions.get(sessionId)?.profile
  }

  async connect(profile: SSHProfile): Promise<SSHConnectResult> {
    const id = profile.id || randomUUID()
    const onStatus = (s: SSHStatus) => this.fireStatus(id, s)

    const { client, jump, jumps } = await establish(establishProfile(profile), onStatus)

    // Context detection opens short-lived exec channels before the session is
    // visible to the renderer. Observe the transport during that bootstrap
    // window so a server/network close cannot be missed and later installed as
    // an apparently live session.
    const bootstrapAbort = new AbortController()
    const onBootstrapClose = () => {
      bootstrapAbort.abort()
    }
    client.once('close', onBootstrapClose)
    try {
      const context = await detectRemoteContext(client, 6000, bootstrapAbort.signal)
      this.sessions.set(id, { id, client, jump, jumps, context, profile })
      client.removeListener('close', onBootstrapClose)
      client.on('close', () => this.handleTransportClose(id, client))
      return { sessionId: id, context }
    } catch (err) {
      // Detection is part of connecting. A transport that fails before the
      // session is installed has no later disconnect path to release it.
      client.removeListener('close', onBootstrapClose)
      try {
        client.end()
        endTunnel(jump, jumps)
      } catch {
        /* ignore */
      }
      throw err
    }
  }

  /**
   * Transport dropped. Suspend port-forward listeners (keep specs for rebind),
   * clear live channels, and schedule reconnect when policy allows — without
   * forgetting the profile (so "Reconnect now" still works after permanent
   * failure).
   */
  private handleTransportClose(sessionId: string, closedClient: Client): void {
    const existing = this.sessions.get(sessionId)
    // A reconnect replaces the Client object while preserving the session id.
    // Late/duplicate close events from an older transport must never reap the
    // replacement or mark its renderer tab closed.
    if (!existing || existing.client !== closedClient || existing.closing) return
    existing.tmuxClientRunning = false
    if (existing.tmuxResumeTimer) {
      clearTimeout(existing.tmuxResumeTimer)
      existing.tmuxResumeTimer = undefined
    }
    this.fireStatus(sessionId, { type: 'closed' })
    this.reportExit(existing)
    this.clearLiveChannels(existing)
    this.forwardManager.suspendBySession(sessionId)
    // Drop the dead client references but keep the session entry + profile.
    existing.client = undefined
    existing.jump = undefined
    existing.jumps = undefined
    if (existing.reconnect) {
      void this.runReconnect(sessionId, existing.reconnect)
    } else if (this.policy.enabled) {
      this.scheduleReconnect(sessionId, existing.profile, existing.shellRequest)
    }
    // else: tombstone remains so a later manual reconnect() can find the profile
  }

  /** Tear down shell/SFTP/setup timers on a session without forgetting the entry. */
  private clearLiveChannels(s: Session): void {
    this.clearSetupTimers(s)
    if (s.tmuxResumeTimer) {
      clearTimeout(s.tmuxResumeTimer)
      s.tmuxResumeTimer = undefined
    }
    if (s.shellRecoveryTimer) {
      clearTimeout(s.shellRecoveryTimer)
      s.shellRecoveryTimer = undefined
    }
    s.tmuxClientRunning = false
    s.shell = undefined
    s.shellDecoder = undefined
    s.shellInflight = undefined
    this.closeAuxClient(s, 'exec')
    this.closeAuxClient(s, 'sftp')
    this.closeWindowsForwardClient(s)
    s.sftp = undefined
    s.sftpInflight = undefined
  }

  /** Report a shell exit once even when channel and transport close race. */
  private reportExit(s: Session): void {
    if (s.exitReported) return
    s.exitReported = true
    this.handlers.onExit(s.id)
  }

  /** Close a Windows compatibility client without treating it as a session drop. */
  private closeAuxClient(s: Session, kind: 'exec' | 'sftp'): void {
    const client = kind === 'exec' ? s.execClient : s.sftpClient
    const jump = kind === 'exec' ? s.execJump : s.sftpJump
    const jumps = kind === 'exec' ? s.execJumps : s.sftpJumps
    if (kind === 'exec') {
      s.execClient = undefined
      s.execJump = undefined
      s.execJumps = undefined
      s.execClientInflight = undefined
      s.execQueue = undefined
    } else {
      s.sftpClient = undefined
      s.sftpJump = undefined
      s.sftpJumps = undefined
      s.sftpClientInflight = undefined
    }
    if (!client) return
    // The auxiliary close listener only clears auxiliary state. Removing it
    // here avoids a late `close` event touching a session being torn down.
    client.removeAllListeners('close')
    try {
      client.end()
      endTunnel(jump, jumps)
    } catch {
      /* ignore */
    }
  }

  private closeWindowsForwardClient(s: Session): void {
    const client = s.forwardClient
    const jump = s.forwardJump
    const jumps = s.forwardJumps
    if (s.forwardIdleTimer) clearTimeout(s.forwardIdleTimer)
    s.forwardClient = undefined
    s.forwardJump = undefined
    s.forwardJumps = undefined
    s.forwardClientInflight = undefined
    s.forwardRefs = 0
    s.forwardIdleTimer = undefined
    if (!client) return
    client.removeAllListeners('close')
    try {
      client.end()
      endTunnel(jump, jumps)
    } catch {
      /* ignore */
    }
  }

  /**
   * Open the command-only connection used by Windows remotes. The primary
   * client must remain alive because it owns the visible interactive shell.
   */
  private ensureWindowsExecClient(sessionId: string): Promise<Client> {
    const s = this.sessions.get(sessionId)
    if (!s) return Promise.reject(new Error('unknown session'))
    if (s.execClient) return Promise.resolve(s.execClient)
    if (s.execClientInflight) return s.execClientInflight
    if (!s.client) return Promise.reject(new Error(RECONNECTING_ERR))

    const primary = s.client
    const inflight = establish(
      establishProfile(s.profile),
      () => {
        /* Auxiliary connection failures belong to the operation, not the shell. */
      },
      { preferLegacyWindowsKex: true }
    ).then(({ client, jump, jumps }) => {
      const current = this.sessions.get(sessionId)
      if (current !== s || s.closing || s.client !== primary) {
        client.end()
        endTunnel(jump, jumps)
        throw new Error(RECONNECTING_ERR)
      }
      s.execClient = client
      s.execJump = jump
      s.execJumps = jumps
      client.on('close', () => {
        if (s.execClient === client) {
          s.execClient = undefined
          s.execJump = undefined
          s.execJumps = undefined
          try {
            endTunnel(jump, jumps)
          } catch {
            /* ignore */
          }
        }
      })
      return client
    })
    s.execClientInflight = inflight
    void inflight.then(
      () => {
        if (s.execClientInflight === inflight) s.execClientInflight = undefined
      },
      () => {
        if (s.execClientInflight === inflight) s.execClientInflight = undefined
      }
    )
    return inflight
  }

  /** Open the SFTP-only connection used by Windows remotes. */
  private ensureWindowsSftpClient(sessionId: string): Promise<Client> {
    const s = this.sessions.get(sessionId)
    if (!s) return Promise.reject(new Error('unknown session'))
    if (s.sftpClient) return Promise.resolve(s.sftpClient)
    if (s.sftpClientInflight) return s.sftpClientInflight
    if (!s.client) return Promise.reject(new Error(RECONNECTING_ERR))

    const primary = s.client
    const inflight = establish(
      establishProfile(s.profile),
      () => {
        /* Auxiliary connection failures belong to the operation, not the shell. */
      },
      { preferLegacyWindowsKex: true }
    ).then(({ client, jump, jumps }) => {
      const current = this.sessions.get(sessionId)
      if (current !== s || s.closing || s.client !== primary) {
        client.end()
        endTunnel(jump, jumps)
        throw new Error(RECONNECTING_ERR)
      }
      s.sftpClient = client
      s.sftpJump = jump
      s.sftpJumps = jumps
      client.on('close', () => {
        if (s.sftpClient === client) {
          s.sftpClient = undefined
          s.sftpJump = undefined
          s.sftpJumps = undefined
          s.sftp = undefined
          try {
            endTunnel(jump, jumps)
          } catch {
            /* ignore */
          }
        }
      })
      return client
    })
    s.sftpClientInflight = inflight
    void inflight.then(
      () => {
        if (s.sftpClientInflight === inflight) s.sftpClientInflight = undefined
      },
      () => {
        if (s.sftpClientInflight === inflight) s.sftpClientInflight = undefined
      }
    )
    return inflight
  }

  /**
   * Keep one bounded forwarding transport per Windows session. Unlike shell
   * session channels, direct-tcpip channels are intended to multiplex. If a
   * particular server rejects them it may reset this pool, but never the
   * operator's visible terminal transport.
   */
  private ensureWindowsForwardClient(sessionId: string): Promise<Client> {
    const s = this.sessions.get(sessionId)
    if (!s) return Promise.reject(new Error('unknown session'))
    if (s.forwardClient) return Promise.resolve(s.forwardClient)
    if (s.forwardClientInflight) return s.forwardClientInflight
    if (!s.client) return Promise.reject(new Error(RECONNECTING_ERR))

    const primary = s.client
    const inflight = establish(
      establishProfile(s.profile),
      () => {
        /* Forwarding failures belong to the local stream, not the shell. */
      },
      { preferLegacyWindowsKex: true }
    ).then(({ client, jump, jumps }) => {
      const current = this.sessions.get(sessionId)
      if (current !== s || s.closing || s.client !== primary) {
        client.end()
        endTunnel(jump, jumps)
        throw new Error(RECONNECTING_ERR)
      }
      s.forwardClient = client
      s.forwardJump = jump
      s.forwardJumps = jumps
      s.forwardRefs = 0
      client.on('close', () => {
        if (s.forwardClient === client) {
          if (s.forwardIdleTimer) clearTimeout(s.forwardIdleTimer)
          s.forwardClient = undefined
          s.forwardJump = undefined
          s.forwardJumps = undefined
          s.forwardRefs = 0
          s.forwardIdleTimer = undefined
          try {
            endTunnel(jump, jumps)
          } catch {
            /* ignore */
          }
        }
      })
      return client
    })
    s.forwardClientInflight = inflight
    void inflight.then(
      () => {
        if (s.forwardClientInflight === inflight) s.forwardClientInflight = undefined
      },
      () => {
        if (s.forwardClientInflight === inflight) s.forwardClientInflight = undefined
      }
    )
    return inflight
  }

  /**
   * Cancel any in-flight auto-reconnect loop for the given session. Idempotent
   * and safe to call when nothing is scheduled.
   */
  cancelReconnect(sessionId: string): void {
    const s = this.sessions.get(sessionId)
    if (!s?.reconnect) return
    clearTimeout(s.reconnect.timer)
    delete s.reconnect
  }

  /**
   * Manually trigger a reconnect for a session that has either never been
   * scheduled one (auto-reconnect disabled) or has just given up. The
   * renderer calls this from the "Reconnect now" button on a closed tab.
   */
  reconnect(sessionId: string, profile?: SSHProfile): void {
    const s = this.sessions.get(sessionId)
    const prof = profile ?? s?.profile
    if (!prof) return
    if (s?.reconnect) {
      clearTimeout(s.reconnect.timer)
      void this.runReconnect(sessionId, s.reconnect)
      return
    }
    // User-initiated reconnect while the session still has a live client:
    // end the old client first so we don't orphan its socket/server session.
    // Detach our close listener first so handleTransportClose doesn't race
    // a second scheduleReconnect with the one we install below.
    if (s?.client) {
      const oldClient = s.client
      const oldJump = s.jump
      const oldJumps = s.jumps
      s.client = undefined
      s.jump = undefined
      s.jumps = undefined
      this.clearLiveChannels(s)
      this.forwardManager.suspendBySession(sessionId)
      oldClient.removeAllListeners('close')
      try {
        oldClient.end()
        endTunnel(oldJump, oldJumps)
      } catch {
        /* ignore */
      }
      this.fireStatus(sessionId, { type: 'closed' })
      this.reportExit(s)
    }
    this.scheduleReconnect(sessionId, prof, s?.shellRequest, /*userInitiated*/ true)
  }

  /**
   * Schedule the first auto-reconnect attempt. The id is the *original* session
   * id (kept stable across reconnects so the renderer's tabs/SFTP/agent
   * bookkeeping survives the swap). The actual fresh `connect()` will mint a
   * new uuid; we then update our internal `Session.id` to match, so callers
   * that have already obtained the new id can still look it up.
   */
  private scheduleReconnect(
    sessionId: string,
    profile: SSHProfile,
    shellRequest?: ShellRequest,
    userInitiated = false
  ): void {
    const policy = { ...this.policy }
    if (!policy.enabled && !userInitiated) return
    const maxAttempts = Math.max(1, policy.maxAttempts)
    const initialDelay = this.computeDelay(0, policy)
    const state: ReconnectState = {
      // Placeholder timer; replaced before the first attempt fires.
      timer: setTimeout(() => undefined, 0),
      attempt: 0,
      maxAttempts,
      policy,
      userInitiated,
      shellRequest
    }
    // Reuse the existing entry when present (keeps context/forwards map key);
    // otherwise install a placeholder so cancelReconnect can find it by id.
    const existing = this.sessions.get(sessionId)
    this.sessions.set(sessionId, {
      id: sessionId,
      client: undefined,
      context: existing?.context ?? { kind: 'remote', os: 'unknown', detail: '', hostname: '' },
      profile,
      reconnect: state,
      shellRequest: shellRequest ?? existing?.shellRequest
    })
    clearTimeout(state.timer)
    state.timer = setTimeout(() => void this.runReconnect(sessionId, state), initialDelay)
    this.fireStatus(sessionId, {
      type: 'reconnecting',
      attempt: 1,
      maxAttempts,
      delayMs: initialDelay
    })
  }

  /**
   * Run a single reconnect attempt. On success the placeholder session is
   * replaced with a fresh live one (same id) and a `reconnected` status fires.
   * On failure we either schedule the next attempt (exponential backoff) or
   * surface `reconnect-failed` if we have used all attempts.
   */
  private async runReconnect(sessionId: string, state: ReconnectState): Promise<void> {
    const s = this.sessions.get(sessionId)
    if (!s || s.reconnect !== state || s.closing || state.running) return
    const profile = s.profile
    state.running = true
    state.attempt += 1
    let pendingClient: Client | undefined
    let pendingJump: Client | undefined
    let pendingJumps: Client[] | undefined
    try {
      const established = await establish(establishProfile(profile), () => {
        /* swallow per-attempt status events — surface only the final outcome */
      })
      pendingClient = established.client
      pendingJump = established.jump
      pendingJumps = established.jumps
      if (this.sessions.get(sessionId) !== s || s.reconnect !== state || s.closing) {
        pendingClient.end()
        endTunnel(pendingJump, pendingJumps)
        pendingClient = undefined
        pendingJump = undefined
        pendingJumps = undefined
        return
      }
      const bootstrapAbort = new AbortController()
      const onBootstrapClose = () => {
        bootstrapAbort.abort()
      }
      pendingClient.once('close', onBootstrapClose)
      const context = await detectRemoteContext(pendingClient, 6000, bootstrapAbort.signal)
      if (this.sessions.get(sessionId) !== s || s.reconnect !== state || s.closing) {
        pendingClient.removeListener('close', onBootstrapClose)
        pendingClient.end()
        endTunnel(pendingJump, pendingJumps)
        pendingClient = undefined
        pendingJump = undefined
        pendingJumps = undefined
        return
      }
      const client = pendingClient
      const jump = pendingJump
      const jumps = pendingJumps
      client.removeListener('close', onBootstrapClose)
      pendingClient = undefined
      pendingJump = undefined
      pendingJumps = undefined
      this.sessions.set(sessionId, {
        id: sessionId,
        client,
        jump,
        jumps,
        context,
        profile,
        // Clear reconnect bookkeeping on success; the next drop starts a new loop.
        shellRequest: state.shellRequest ?? s.shellRequest
      })
      client.on('close', () => this.handleTransportClose(sessionId, client))
      // Re-establish -L/-D listeners that were suspended on the previous drop.
      try {
        await this.forwardManager.rebind(sessionId)
      } catch (err) {
        console.warn('[ssh] port-forward rebind failed:', err)
      }
      if (state.shellRequest) {
        try {
          await this.openShell(sessionId, state.shellRequest.cols, state.shellRequest.rows, {
            detached: state.shellRequest.detached,
            tmuxSession: state.shellRequest.tmuxSession
          })
        } catch (err) {
          this.handlers.onData(
            sessionId,
            `\r\n\x1b[31m[SSH reconnected, but the shell could not be restored: ${(err as Error).message}]\x1b[0m\r\n`
          )
        }
      }
      this.fireStatus(sessionId, { type: 'reconnected', attempt: state.attempt })
    } catch (err) {
      try {
        pendingClient?.end()
        endTunnel(pendingJump, pendingJumps)
      } catch {
        /* ignore */
      }
      if (this.sessions.get(sessionId) !== s || s.reconnect !== state || s.closing) return
      const reason = (err as Error).message || String(err)
      state.lastError = reason
      if (state.attempt >= state.maxAttempts) {
        // Keep a profile tombstone so "Reconnect now" still works.
        const cur = this.sessions.get(sessionId)
        if (cur) {
          delete cur.reconnect
          cur.client = undefined
          cur.jump = undefined
          cur.jumps = undefined
        } else {
          this.sessions.set(sessionId, {
            id: sessionId,
            client: undefined,
            context: { kind: 'remote', os: 'unknown', detail: '', hostname: '' },
            profile
          })
        }
        this.fireStatus(sessionId, {
          type: 'reconnect-failed',
          attempts: state.attempt,
          reason
        })
        return
      }
      const delay = this.computeDelay(state.attempt, state.policy)
      this.fireStatus(sessionId, {
        type: 'reconnecting',
        attempt: state.attempt + 1,
        maxAttempts: state.maxAttempts,
        delayMs: delay
      })
      state.timer = setTimeout(() => void this.runReconnect(sessionId, state), delay)
    } finally {
      state.running = false
    }
  }

  /** Classic exponential backoff: base * factor^attempt, clamped to maxDelayMs. */
  private computeDelay(attempt: number, policy: ReconnectPolicy): number {
    const raw = policy.baseDelayMs * Math.pow(policy.factor, Math.max(0, attempt))
    return Math.min(policy.maxDelayMs, Math.max(0, Math.floor(raw)))
  }

  openShell(
    sessionId: string,
    cols: number,
    rows: number,
    options: SSHOpenShellOptions = {}
  ): Promise<void> {
    const s = this.sessions.get(sessionId)
    if (!s) return Promise.reject(new Error('unknown session'))
    const prevTmux = s.shellRequest?.tmuxSession
    s.shellRequest = {
      cols: Math.max(1, cols),
      rows: Math.max(1, rows),
      detached: options.detached === true,
      tmuxSession: 'tmuxSession' in options ? options.tmuxSession || undefined : prevTmux
    }
    if (s.shell) return Promise.resolve()
    if (!s.client) return Promise.reject(new Error(RECONNECTING_ERR))
    if (s.shellInflight) return s.shellInflight
    const client = s.client
    const inflight = new Promise<void>((resolve, reject) => {
      // Keep PTY echo on for POSIX remotes. The quiet inject briefly disables
      // it with `stty -echo` only for the setup one-liner. Opening with ECHO:0
      // permanently hid keystrokes whenever that inject raced a long MOTD
      // (Bazzite and similar) and never reached its trailing `stty echo`.
      const pty = { term: 'xterm-256color', cols, rows }
      const onChannel = (err: Error | undefined | null, channel?: ClientChannel) => {
        s.shellInflight = undefined
        if (err) return reject(err)
        if (!channel) return reject(new Error('no shell channel'))
        s.shell = channel
        s.exitReported = false
        // Stream every chunk through a per-session UTF-8 decoder so multi-byte
        // codepoints split across ssh2 data events decode correctly instead
        // of turning into U+FFFD. The close handler flushes any trailing bytes
        // the decoder buffered (the final incomplete codepoint renders as a
        // single replacement char).
        s.shellDecoder = new TextDecoder('utf-8', { fatal: false })
        const dec = s.shellDecoder
        const emitShellData = (chunk: string) => {
          if (!chunk) return
          if (s.shellIntegrationPending) this.noteShellIntegrationOutput(s)
          if (s.tmuxClientRunning && TMUX_CLIENT_LEFT_RE.test(chunk)) {
            this.scheduleResumeAfterTmux(sessionId)
          }
          this.handlers.onData(sessionId, chunk)
        }
        let receivedExit = false
        channel
          .on('data', (d: Buffer) => {
            emitShellData(dec.decode(d, { stream: true }))
          })
          .on('exit', () => {
            receivedExit = true
          })
          .on('error', (err: Error) => {
            console.warn(`[ssh] shell channel error (${sessionId}):`, err.message)
          })
          .on('close', () => {
            // This channel belongs to the Session object and Client captured
            // when it was opened. A late close after reconnect must not mark
            // the replacement shell (same public id) as closed.
            if (this.sessions.get(sessionId) !== s || s.client !== client || s.closing) return
            s.shell = undefined
            if (s.shellDecoder) {
              const tail = s.shellDecoder.decode()
              if (tail) emitShellData(tail)
              s.shellDecoder = undefined
            }
            // `exec tmux` + detach (or a crashed tmux client) closes this
            // channel while the ssh2 client is still up. Don't tell the
            // renderer the connection died — resume a login shell instead.
            if (s.tmuxClientRunning && s.client && !s.closing && !s.reconnect) {
              this.scheduleResumeAfterTmux(sessionId)
              return
            }
            // Win32-OpenSSH can drop the long-lived PowerShell exec channel
            // without closing the SSH transport. Do not report the whole
            // connection dead: reopen the shell and preserve input typed while
            // the replacement channel is negotiating. A real `exit` event is
            // still treated as the operator/process intentionally leaving.
            if (s.context.os === 'windows' && !receivedExit) {
              this.scheduleWindowsShellRecovery(sessionId, s, client)
              return
            }
            this.reportExit(s)
          })
        channel.stderr.on('data', (d: Buffer) => {
          emitShellData(dec.decode(d, { stream: true }))
        })

        // Reconnect path: the operator already chose a session. Attach as a
        // child (never exec) so a later detach returns to this login shell.
        if (s.shellRequest?.tmuxSession && (s.context.os === 'linux' || s.context.os === 'mac')) {
          this.writeTmuxAttach(s, s.shellRequest.tmuxSession, false)
        }

        // Best-effort OSC 7 cwd reporting for POSIX remotes so the file explorer
        // can follow `cd`. The hook must be wired per-shell: bash re-runs
        // PROMPT_COMMAND before each prompt, while zsh ignores it and instead
        // calls the functions in `precmd_functions`. We detect the live shell via
        // $ZSH_VERSION (set in the interactive shell, so more reliable than probing)
        // and append to whichever mechanism applies — preserving the distro's own
        // hooks and staying idempotent.
        //
        // Wait for the login MOTD to go quiet, then inject with a brief
        // `stty -echo` window (never leave the PTY echo-off by default).
        // Skipped when we are about to attach tmux — that path would otherwise
        // type the script into the pane.
        if ((s.context.os === 'linux' || s.context.os === 'mac') && !s.shellRequest?.tmuxSession) {
          this.schedulePosixShellIntegration(s)
        }
        resolve()
      }
      if (s.context.os === 'windows') {
        // Win32-OpenSSH can be configured with `ForceCommand` or a shell
        // implementation that rejects SSH `shell` requests with a message
        // such as “Interactive mode not supported. Use command exec instead.”
        // Use an interactive exec channel for Windows and never fall back to
        // `client.shell()` there. PowerShell is the useful default for agents;
        // cmd.exe keeps the terminal usable on minimal Windows installations.
        const promptSetup =
          `function prompt { $e=[char]27; $b=[char]7; $p=$PWD.ProviderPath; ` +
          `$u=($p -replace '\\\\','/'); ` +
          `Write-Host -NoNewline ($e + ']133;A' + $b + $e + ']7;file:///' + $u + $b); ` +
          `('PS ' + $p + '> ' + $e + ']133;B' + $b) }`
        client.exec(windowsPowerShellInteractiveCommand(promptSetup), { pty }, (err, channel) => {
          if (!err && channel) {
            onChannel(undefined, channel)
            return
          }
          const powershellError = err ?? new Error('PowerShell exec channel was not opened')
          client.exec('cmd.exe', { pty }, (fallbackErr, fallbackChannel) => {
            if (!fallbackErr && fallbackChannel) {
              onChannel(undefined, fallbackChannel)
              return
            }
            onChannel(
              fallbackErr ??
                new Error(`Windows shell could not be opened: ${powershellError.message}`),
              fallbackChannel
            )
          })
        })
      } else {
        client.shell(pty, onChannel)
      }
    })
    s.shellInflight = inflight
    return inflight
  }

  private scheduleWindowsShellRecovery(sessionId: string, s: Session, client: Client): void {
    if (s.shellRecoveryTimer || s.closing || s.reconnect || s.client !== client) return
    const request = s.shellRequest
    if (!request) {
      this.reportExit(s)
      return
    }
    const now = Date.now()
    if (
      s.shellRecoveryWindowStartedAt === undefined ||
      now - s.shellRecoveryWindowStartedAt > 60_000
    ) {
      s.shellRecoveryWindowStartedAt = now
      s.shellRecoveryAttempts = 0
    }
    const attempt = (s.shellRecoveryAttempts ?? 0) + 1
    s.shellRecoveryAttempts = attempt
    if (attempt > 3) {
      this.handlers.onData(
        sessionId,
        '\r\n\x1b[31m[Windows shell repeatedly closed; automatic recovery stopped]\x1b[0m\r\n'
      )
      this.reportExit(s)
      return
    }
    const delayMs = [250, 1000, 3000][attempt - 1]
    s.shellRecoveryTimer = setTimeout(() => {
      s.shellRecoveryTimer = undefined
      if (
        this.sessions.get(sessionId) !== s ||
        s.closing ||
        s.reconnect ||
        s.client !== client ||
        s.shell
      ) {
        return
      }
      this.handlers.onData(
        sessionId,
        `\r\n\x1b[90m[DevTerm: Windows shell channel closed; recovering (${attempt}/3)…]\x1b[0m\r\n`
      )
      void this.openShell(sessionId, request.cols, request.rows, {
        detached: request.detached,
        tmuxSession: request.tmuxSession
      }).catch((err) => {
        if (this.sessions.get(sessionId) !== s || s.closing || s.reconnect || s.client !== client) {
          return
        }
        this.handlers.onData(
          sessionId,
          `\r\n\x1b[31m[Windows shell recovery failed: ${(err as Error).message}; reconnecting SSH]\x1b[0m\r\n`
        )
        // A client that cannot open a replacement shell is no longer useful.
        // Ending it drives the normal transport-close/reconnect path.
        client.end()
      })
    }, delayMs)
  }

  /**
   * Lazily open an SFTP channel. Normal remotes use the session's existing
   * client; Windows remotes use their SFTP-only compatibility client so a
   * server that permits only one channel cannot reset the visible shell.
   */
  getSftp(sessionId: string): Promise<SFTPWrapper> {
    const s = this.sessions.get(sessionId)
    if (!s) return Promise.reject(new Error('unknown session'))
    if (s.sftp) return Promise.resolve(s.sftp)
    if (s.sftpInflight) return s.sftpInflight

    const primary = s.client
    const inflight = (async () => {
      const client =
        s.context.os === 'windows' ? await this.ensureWindowsSftpClient(sessionId) : primary
      if (!client) throw new Error(RECONNECTING_ERR)
      return new Promise<SFTPWrapper>((resolve, reject) => {
        client.sftp((err, sftp) => {
          const current = this.sessions.get(sessionId)
          const clientStillBelongs =
            current === s &&
            !s.closing &&
            (s.context.os === 'windows' ? s.sftpClient === client : s.client === client)
          if (err) return reject(err)
          if (!clientStillBelongs) {
            try {
              sftp.end()
            } catch {
              /* ignore */
            }
            return reject(new Error(RECONNECTING_ERR))
          }
          s.sftp = sftp
          // Only clear the cache if this wrapper is still the one we stored —
          // a later open must not be wiped by a leaked wrapper's close.
          sftp.on('close', () => {
            if (s.sftp === sftp) s.sftp = undefined
          })
          resolve(sftp)
        })
      })
    })()
    s.sftpInflight = inflight
    void inflight.then(
      () => {
        if (s.sftpInflight === inflight) s.sftpInflight = undefined
      },
      () => {
        if (s.sftpInflight === inflight) s.sftpInflight = undefined
      }
    )
    return inflight
  }

  getContext(sessionId: string): HostContext | undefined {
    return this.sessions.get(sessionId)?.context
  }

  /**
   * One-shot command over a dedicated exec channel on the session's client.
   * On timeout we RESOLVE (never reject) with `timedOut: true` plus whatever
   * output arrived so far: the command keeps running on the host and the ssh2
   * client is untouched, so a timeout is NOT a disconnect. Callers must report
   * it as such rather than letting it read as a dead connection.
   */
  exec(
    sessionId: string,
    command: string,
    timeoutMs = 30000
  ): Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean }> {
    const s = this.sessions.get(sessionId)
    if (!s) return Promise.reject(new Error('unknown session'))
    if (s.context.os === 'windows') {
      // Windows OpenSSH installations commonly have MaxSessions=1. Queue
      // command channels per session so Git/status and an agent tool cannot
      // race each other on the dedicated command connection.
      const previous = s.execQueue ?? Promise.resolve()
      const queued = previous
        .catch(() => undefined)
        .then(async () =>
          this.execOnClient(await this.ensureWindowsExecClient(sessionId), command, timeoutMs)
        )
      const queueTail = queued.then(
        () => undefined,
        () => undefined
      )
      s.execQueue = queueTail
      void queueTail.then(() => {
        if (s.execQueue === queueTail) s.execQueue = undefined
      })
      return queued
    }
    if (!s.client) return Promise.reject(new Error(RECONNECTING_ERR))
    const gate = s.execGate ?? (s.execGate = createExecGate(POSIX_EXEC_SLOTS))
    return gate.acquire().then(async (release) => {
      try {
        const current = this.sessions.get(sessionId)
        if (!current?.client || current !== s) throw new Error(RECONNECTING_ERR)
        return await this.execOnClient(current.client, command, timeoutMs)
      } finally {
        release()
      }
    })
  }

  private execOnClient(
    client: Client,
    command: string,
    timeoutMs: number
  ): Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean }> {
    return new Promise((resolve, reject) => {
      let settled = false
      const stdoutChunks: Buffer[] = []
      const stderrChunks: Buffer[] = []
      let streamRef: ClientChannel | undefined
      let exitCode: number | null = null
      // Decode once on completion so multi-byte UTF-8 codepoints split across
      // ssh2 data chunks aren't turned into U+FFFD by per-chunk `.toString()`.
      const snapshot = () => ({
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8')
      })
      const detach = () => {
        if (!streamRef) return
        streamRef.removeAllListeners('data')
        streamRef.stderr.removeAllListeners('data')
        try {
          streamRef.close()
        } catch {
          /* ignore */
        }
      }
      const finish = (r: {
        stdout: string
        stderr: string
        code: number | null
        timedOut: boolean
      }) => {
        if (!settled) {
          settled = true
          resolve(r)
        }
      }
      const timer = setTimeout(() => {
        detach()
        finish({ ...snapshot(), code: null, timedOut: true })
      }, timeoutMs)
      try {
        client.exec(command, (err, stream) => {
          if (err) {
            clearTimeout(timer)
            reject(err)
            return
          }
          // The timeout may fire while ssh2 is still negotiating the channel.
          // If its callback arrives later, close that stale channel immediately
          // so it cannot overlap a shell or consume a server MaxSessions slot.
          if (settled) {
            stream.on('error', () => undefined)
            try {
              stream.close()
            } catch {
              /* ignore */
            }
            return
          }
          streamRef = stream
          stream
            .on('exit', (code: number | null) => {
              exitCode = typeof code === 'number' ? code : null
            })
            .on('close', (c: number) => {
              clearTimeout(timer)
              finish({
                ...snapshot(),
                code: exitCode ?? (typeof c === 'number' ? c : null),
                timedOut: false
              })
            })
            .on('error', (streamError: Error) => {
              clearTimeout(timer)
              if (!settled) reject(streamError)
            })
            .on('data', (d: Buffer) => {
              if (!settled) stdoutChunks.push(d)
            })
            .stderr.on('data', (d: Buffer) => {
              if (!settled) stderrChunks.push(d)
            })
        })
      } catch (err) {
        clearTimeout(timer)
        reject(err)
      }
    })
  }

  input(sessionId: string, data: string): void {
    const session = this.sessions.get(sessionId)
    if (!session?.shell) return
    session.shell.write(
      session.context.os === 'windows' ? normalizeWindowsInteractiveInput(data) : data
    )
  }

  /**
   * Probe tmux on the remote via a dedicated exec channel (does not touch
   * the interactive shell / MOTD). Broken binaries (`tmux -V` fails) count
   * as unavailable so we never offer a picker the attach step cannot honor.
   */
  async listTmux(sessionId: string, timeoutMs = 12000): Promise<TmuxListing> {
    const s = this.sessions.get(sessionId)
    if (!s) return { available: false, sessions: [], error: 'unknown session' }
    if (!s.client) return { available: false, sessions: [], error: RECONNECTING_ERR }
    if (s.context.os !== 'linux' && s.context.os !== 'mac') {
      return { available: false, sessions: [] }
    }
    try {
      const boundedTimeoutMs = Math.max(250, Math.min(12000, timeoutMs))
      const result = await this.exec(sessionId, TMUX_PROBE_AND_LIST, boundedTimeoutMs)
      return parseTmuxListing(result.stdout, result.stderr)
    } catch (err) {
      return { available: false, sessions: [], error: (err as Error).message }
    }
  }

  /**
   * Attach the live login shell to a tmux session, or record that the
   * operator chose a normal shell. Never `exec`s — see `buildTmuxAttachCommand`.
   */
  attachTmux(sessionId: string, req: TmuxAttachRequest): Promise<void> {
    const s = this.sessions.get(sessionId)
    if (!s) return Promise.reject(new Error('unknown session'))
    if (!s.shell) return Promise.reject(new Error('shell not open'))
    const name = (req.name ?? '').trim()
    if (!name) {
      if (s.tmuxClientRunning) return this.detachTmuxClient(s)
      s.tmuxClientRunning = false
      if (s.shellRequest) s.shellRequest.tmuxSession = undefined
      return Promise.resolve()
    }
    if (s.tmuxClientRunning) {
      return this.switchTmuxClient(s, name, req.create === true)
    }
    if (s.shellRequest) s.shellRequest.tmuxSession = name
    this.writeTmuxAttach(s, name, req.create === true)
    return Promise.resolve()
  }

  /**
   * `tmux kill-session` over exec so it never types into the live pane.
   * Missing sessions count as success (already gone).
   */
  async killTmux(sessionId: string, name: string): Promise<void> {
    const s = this.sessions.get(sessionId)
    if (!s) throw new Error('unknown session')
    if (!s.client) throw new Error(RECONNECTING_ERR)
    const trimmed = name.trim()
    if (!trimmed) throw new Error('missing tmux session name')
    const result = await this.exec(sessionId, buildTmuxKillCommand(trimmed), 8000)
    if (result.timedOut) throw new Error('tmux kill timed out')
    if (!isTmuxSessionGone(result.stdout, result.stderr, result.code)) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || 'tmux kill-session failed')
    }
    if (s.shellRequest?.tmuxSession === trimmed) {
      s.shellRequest.tmuxSession = undefined
    }
  }

  private async clientTtyFor(s: Session): Promise<string | undefined> {
    const current = s.shellRequest?.tmuxSession
    if (!current) return undefined
    const listed = await this.exec(s.id, TMUX_LIST_CLIENTS, 6000)
    return pickClientTty(parseTmuxClients(listed.stdout), current)
  }

  /** Switch the pane's existing tmux client to another session (no shell inject). */
  private async switchTmuxClient(s: Session, name: string, create: boolean): Promise<void> {
    const tty = await this.clientTtyFor(s)
    if (!tty) {
      if (s.shellRequest) s.shellRequest.tmuxSession = name
      this.writeTmuxAttach(s, name, create)
      return
    }
    if (create) {
      await this.exec(s.id, buildTmuxEnsureSessionCommand(name), 8000)
    }
    const result = await this.exec(s.id, buildTmuxSwitchCommand(tty, name), 8000)
    if (result.timedOut) throw new Error('tmux switch timed out')
    if (result.code && result.code !== 0) {
      throw new Error(result.stderr.trim() || 'tmux switch-client failed')
    }
    if (s.shellRequest) s.shellRequest.tmuxSession = name
  }

  private async detachTmuxClient(s: Session): Promise<void> {
    const tty = await this.clientTtyFor(s)
    if (s.shellRequest) s.shellRequest.tmuxSession = undefined
    if (!tty) {
      s.tmuxClientRunning = false
      return
    }
    await this.exec(s.id, buildTmuxDetachClientCommand(tty), 8000)
  }

  private clearSetupTimers(s: Session): void {
    if (s.setupTimers) {
      for (const t of s.setupTimers) clearTimeout(t)
      s.setupTimers.clear()
    }
    s.shellIntegrationPending = false
    s.shellIntegrationArmIdle = undefined
  }

  private trackTimer(s: Session, t: NodeJS.Timeout): void {
    if (!s.setupTimers) s.setupTimers = new Set()
    s.setupTimers.add(t)
  }

  /**
   * Defer OSC hook install until login output goes quiet (MOTD finished) or
   * {@link SHELL_INTEGRATION_MAX_WAIT_MS} elapses. Fixed short delays raced
   * long banners and left the tty echo-off so typing was invisible.
   */
  private schedulePosixShellIntegration(s: Session): void {
    if (s.shellIntegrationPending) return
    s.shellIntegrationPending = true
    let idleTimer: NodeJS.Timeout | undefined
    const fire = (): void => {
      if (!s.shellIntegrationPending) return
      s.shellIntegrationPending = false
      s.shellIntegrationArmIdle = undefined
      if (idleTimer && s.setupTimers) {
        clearTimeout(idleTimer)
        s.setupTimers.delete(idleTimer)
        idleTimer = undefined
      }
      // Attaching tmux cancels pending setup; never type hooks into a pane.
      if (!s.shell || s.shellRequest?.tmuxSession) return
      this.writeQuiet(s, buildPosixShellIntegrationSetup())
      this.scheduleEchoRestore(s, ECHO_RESTORE_FAILSAFE_MS)
    }
    s.shellIntegrationArmIdle = (): void => {
      if (!s.shellIntegrationPending) return
      if (idleTimer) {
        clearTimeout(idleTimer)
        if (s.setupTimers) s.setupTimers.delete(idleTimer)
      }
      idleTimer = setTimeout(fire, SHELL_INTEGRATION_IDLE_MS)
      this.trackTimer(s, idleTimer)
    }
    // Do not arm idle until the first output byte — a slow MOTD start must not
    // look like "settled". Prompt-only hosts still inject via max-wait or the
    // idle armed from their first prompt chunk.
    const maxTimer = setTimeout(fire, SHELL_INTEGRATION_MAX_WAIT_MS)
    this.trackTimer(s, maxTimer)
  }

  private noteShellIntegrationOutput(s: Session): void {
    s.shellIntegrationArmIdle?.()
  }

  private scheduleEchoRestore(s: Session, delayMs: number): void {
    const t = setTimeout(() => {
      if (s.setupTimers) s.setupTimers.delete(t)
      if (!s.shell || s.tmuxClientRunning) return
      s.shell.write(STTY_ENABLE_ECHO)
    }, delayMs)
    this.trackTimer(s, t)
  }

  /**
   * Run a login-shell command without painting it: disable echo, wait for
   * that to take effect, then write `script`. `script` should restore echo
   * (`stty echo`) if the operator needs to type afterwards.
   */
  private writeQuiet(s: Session, script: string): void {
    if (!s.shell) return
    s.shell.write(STTY_DISABLE_ECHO)
    const t = setTimeout(() => {
      if (s.setupTimers) s.setupTimers.delete(t)
      if (s.shell) s.shell.write(script)
    }, QUIET_WRITE_GAP_MS)
    this.trackTimer(s, t)
  }

  private writeTmuxAttach(s: Session, name: string, create: boolean): void {
    if (!s.shell) return
    s.tmuxClientRunning = true
    // Drop a pending login-shell inject so it cannot land inside tmux.
    this.clearSetupTimers(s)
    this.writeQuiet(s, buildTmuxAttachCommand(name, { create }))
    // Brand-new sessions start a login shell in the pane — safe to hook once
    // that pane's MOTD settles. Existing sessions may be vim/htop; never type
    // the setup into those.
    if (create && (s.context.os === 'linux' || s.context.os === 'mac')) {
      this.schedulePosixShellIntegration(s)
    }
  }

  /**
   * After tmux prints `[detached]`/`[exited]`, or the shell channel closes
   * while a tmux client was in the foreground: if the login shell is still
   * there, just drop the flag; if the channel died (classic `exec tmux`
   * detach), open a fresh normal shell so the pane stays usable.
   */
  private scheduleResumeAfterTmux(sessionId: string): void {
    const s = this.sessions.get(sessionId)
    if (!s || s.tmuxResumeTimer) return
    s.tmuxResumeTimer = setTimeout(() => {
      s.tmuxResumeTimer = undefined
      this.resumeAfterTmuxClient(sessionId)
    }, 80)
  }

  private resumeAfterTmuxClient(sessionId: string): void {
    const s = this.sessions.get(sessionId)
    if (!s || s.closing || !s.client || s.reconnect) return
    if (s.shell) {
      // Detach returned to the login shell (the no-exec path). Forget the
      // attach target so a later SSH reconnect does not yank them back in.
      s.tmuxClientRunning = false
      if (s.shellRequest) s.shellRequest.tmuxSession = undefined
      return
    }
    s.tmuxClientRunning = false
    if (s.shellRequest) s.shellRequest.tmuxSession = undefined
    this.handlers.onData(
      sessionId,
      '\r\n\x1b[90m[DevTerm: left tmux; opening a normal shell]\x1b[0m\r\n'
    )
    const cols = s.shellRequest?.cols ?? 80
    const rows = s.shellRequest?.rows ?? 24
    void this.openShell(sessionId, cols, rows, { detached: false, tmuxSession: '' })
  }

  resize(sessionId: string, cols: number, rows: number): void {
    if (cols > 0 && rows > 0) {
      const session = this.sessions.get(sessionId)
      if (session?.shellRequest) {
        session.shellRequest.cols = cols
        session.shellRequest.rows = rows
      }
      session?.shell?.setWindow(rows, cols, 0, 0)
    }
  }

  disconnect(sessionId: string): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    s.closing = true
    s.tmuxClientRunning = false
    if (s.tmuxResumeTimer) {
      clearTimeout(s.tmuxResumeTimer)
      s.tmuxResumeTimer = undefined
    }
    if (s.shellRecoveryTimer) {
      clearTimeout(s.shellRecoveryTimer)
      s.shellRecoveryTimer = undefined
    }
    // Cancel any pending shell-setup timers so they don't write to a closed channel.
    this.clearSetupTimers(s)
    // Cancel any in-flight reconnect loop first so the close handler does
    // not race a new attempt. Use the same flag the close handler checks
    // (`s.reconnect`) — clearTimeout + delete it from the session record.
    if (s.reconnect) {
      clearTimeout(s.reconnect.timer)
      delete s.reconnect
    }
    // The placeholder session has no live client (`client === undefined`),
    // but auxiliary Windows clients may still be finishing a command.
    this.closeAuxClient(s, 'exec')
    this.closeAuxClient(s, 'sftp')
    this.closeWindowsForwardClient(s)
    if (s.client) {
      try {
        s.shell?.close()
        s.client.end()
        endTunnel(s.jump, s.jumps)
      } catch {
        /* ignore */
      }
    }
    this.handlers.onDispose?.(sessionId)
    this.cleanup(sessionId)
  }

  private cleanup(sessionId: string): void {
    this.forwardManager.removeBySession(sessionId)
    this.sessions.delete(sessionId)
  }

  disconnectAll(): void {
    for (const id of [...this.sessions.keys()]) this.disconnect(id)
  }
}
