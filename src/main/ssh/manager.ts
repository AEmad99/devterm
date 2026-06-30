import { randomUUID } from 'crypto'
import type { Client, ClientChannel, SFTPWrapper } from 'ssh2'
import type { HostContext, SSHConnectResult, SSHProfile, SSHStatus } from '@shared/types'
import { establish } from './connection'
import { detectRemoteContext } from './osDetect'

interface Session {
  id: string
  client: Client
  jump?: Client
  shell?: ClientChannel
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
  context: HostContext
  /**
   * The original profile the session was opened with. Kept so the
   * auto-reconnect loop can re-issue `establish` with the same auth/host
   * without the renderer having to remember the password.
   */
  profile: SSHProfile
  /** Active reconnect loop, if any. Set by the manager when scheduling a retry. */
  reconnect?: ReconnectState
  /**
   * Cached result of the post-open shell probe for the Windows-PowerShell
   * branch. The probe is `echo $PSVersionTable`; the response is checked
   * once and held so we don't re-probe on every prompt (and so the
   * shell-setup branch in `openShell` can skip straight to injection).
   * `null` = unknown / not yet probed. `true` = PowerShell detected.
   */
  isWindowsPowerShell?: boolean
}

interface ReconnectState {
  /** Timer for the next attempt; cleared when the loop is cancelled. */
  timer: NodeJS.Timeout
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
 * Detect whether the open shell on a Windows remote is PowerShell. The probe
 * is `echo $PSVersionTable` (PowerShell evaluates the variable, cmd.exe
 * echoes it literally). Wrapped in a timeout so a misbehaving host can't
 * stall the shell-open path. Result is cached per session so the OSC 7
 * injection in `openShell` doesn't have to re-probe.
 *
 * NOTE: cmd.exe does not support OSC 7 at all (it has no prompt function
 * hook; `prompt $G` doesn't emit one). We fall back to no-OSC-7 there and
 * surface a comment in the shell-setup branch explaining the limitation.
 */
async function probeWindowsShell(client: Client): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const done = (v: boolean) => {
      if (settled) return
      settled = true
      resolve(v)
    }
    const timer = setTimeout(() => done(false), 5000)
    client.exec('echo $PSVersionTable', (err, stream) => {
      if (err) {
        clearTimeout(timer)
        return done(false)
      }
      const stdoutChunks: Buffer[] = []
      stream
        .on('close', () => {
          clearTimeout(timer)
          // PowerShell renders the table as a multi-line ASCII string starting
          // with the header line "Name                           Value"; cmd.exe
          // just prints "$PSVersionTable" verbatim. Match the table header.
          // Decode once on completion so multi-byte UTF-8 split across ssh2
          // data chunks isn't mangled into U+FFFD.
          const stdout = Buffer.concat(stdoutChunks).toString('utf8')
          done(/^\s*Name\s+Value/m.test(stdout))
        })
        .on('data', (d: Buffer) => stdoutChunks.push(d))
        .stderr.on('data', () => {
          /* ignore — probe failure is non-fatal */
        })
    })
  })
}

export interface SSHHandlers {
  onData: (sessionId: string, data: string) => void
  onExit: (sessionId: string) => void
  onStatus: (sessionId: string, status: SSHStatus) => void
}

/** Listener registered via `addStatusListener`; called for every status event. */
export type SSHStatusListener = (status: SSHStatus) => void

/**
 * Owns SSH sessions. One ssh2 client per session; the human shell is one
 * channel on it (SFTP and the MCP bridge will open further channels on the
 * SAME client in later phases — never a second connection).
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

  constructor(private handlers: SSHHandlers) {}

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

  async connect(profile: SSHProfile): Promise<SSHConnectResult> {
    const id = profile.id || randomUUID()
    const onStatus = (s: SSHStatus) => this.fireStatus(id, s)

    const { client, jump } = await establish(
      {
        host: profile.host,
        port: profile.port,
        username: profile.username,
        password: profile.password,
        privateKeyPath: profile.privateKeyPath,
        passphrase: profile.passphrase,
        jump: profile.jump
      },
      onStatus
    )

    client.on('close', () => {
      onStatus({ type: 'closed' })
      this.handlers.onExit(id)
      // The session is now gone from our map. If auto-reconnect is in effect
      // (or the user explicitly retried after a permanent failure), schedule
      // the next attempt with the saved profile.
      const reaped = this.sessions.get(id)
      if (!reaped) return
      this.cleanup(id)
      if (reaped.reconnect) {
        // User-initiated retry: timer was already cleared by `reconnect()`.
        void this.runReconnect(id, reaped.reconnect)
      } else if (this.policy.enabled) {
        this.scheduleReconnect(id, reaped.profile)
      }
    })

    const context = await detectRemoteContext(client)
    this.sessions.set(id, { id, client, jump, context, profile })
    return { sessionId: id, context }
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
    this.scheduleReconnect(sessionId, prof, /*userInitiated*/ true)
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
      userInitiated
    }
    // Persist the state on a sentinel "pre-session" entry so `cancelReconnect`
    // can find it by id even before the first attempt has been made.
    this.sessions.set(sessionId, {
      id: sessionId,
      client: undefined as unknown as Client, // placeholder; replaced on success
      context: { kind: 'remote', os: 'unknown', detail: '', hostname: '' },
      profile,
      reconnect: state
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
    if (!s) return
    const profile = s.profile
    state.attempt += 1
    try {
      // We don't have a fresh id yet — `connect` mints one if the profile has
      // no `id` (we strip it so the manager does mint a new uuid) and returns
      // a new id. To keep the original session id stable across reconnects, we
      // *override* `profile.id` on the way in.
      const { client, jump } = await establish(
        {
          host: profile.host,
          port: profile.port,
          username: profile.username,
          password: profile.password,
          privateKeyPath: profile.privateKeyPath,
          passphrase: profile.passphrase,
          jump: profile.jump
        },
        () => {
          /* swallow per-attempt status events — surface only the final outcome */
        }
      )
      const context = await detectRemoteContext(client)
      // The client is now alive; re-wire the close handler to schedule the
      // next reconnect if it drops again.
      client.on('close', () => {
        this.fireStatus(sessionId, { type: 'closed' })
        this.handlers.onExit(sessionId)
        const cur = this.sessions.get(sessionId)
        if (!cur) return
        this.cleanup(sessionId)
        if (cur.reconnect) {
          void this.runReconnect(sessionId, cur.reconnect)
        } else if (this.policy.enabled) {
          this.scheduleReconnect(sessionId, cur.profile)
        }
      })
      this.sessions.set(sessionId, {
        id: sessionId,
        client,
        jump,
        context,
        profile,
        reconnect: state
      })
      this.fireStatus(sessionId, { type: 'reconnected', attempt: state.attempt })
    } catch (err) {
      const reason = (err as Error).message || String(err)
      state.lastError = reason
      if (state.attempt >= state.maxAttempts) {
        delete this.sessions.get(sessionId)?.reconnect
        this.sessions.delete(sessionId)
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
    }
  }

  /** Classic exponential backoff: base * factor^attempt, clamped to maxDelayMs. */
  private computeDelay(attempt: number, policy: ReconnectPolicy): number {
    const raw = policy.baseDelayMs * Math.pow(policy.factor, Math.max(0, attempt))
    return Math.min(policy.maxDelayMs, Math.max(0, Math.floor(raw)))
  }

  /**
   * Return the session's live ssh2 client (looked up, never instantiated). The
   * caller MUST NOT cache the result across reconnects — the client object is
   * replaced by the auto-reconnect loop, and features bound to a session
   * (SFTP, port forwards, agent tools) re-fetch this each time. Used by
   * `port-forward.ts` to open `forwardOut` channels on the existing client.
   */
  getClient(sessionId: string): Client | undefined {
    return this.sessions.get(sessionId)?.client
  }

  openShell(sessionId: string, cols: number, rows: number): Promise<void> {
    const s = this.sessions.get(sessionId)
    if (!s) return Promise.reject(new Error('unknown session'))
    if (s.shell) return Promise.resolve()
    return new Promise((resolve, reject) => {
      s.client.shell({ term: 'xterm-256color', cols, rows }, (err, channel) => {
        if (err) return reject(err)
        s.shell = channel
        // Stream every chunk through a per-session UTF-8 decoder so multi-byte
        // codepoints split across ssh2 data events decode correctly instead
        // of turning into U+FFFD. The close handler flushes any trailing bytes
        // the decoder buffered (the final incomplete codepoint renders as a
        // single replacement char).
        s.shellDecoder = new TextDecoder('utf-8', { fatal: false })
        const dec = s.shellDecoder
        channel
          .on('data', (d: Buffer) => {
            this.handlers.onData(sessionId, dec.decode(d, { stream: true }))
          })
          .on('close', () => {
            this.handlers.onExit(sessionId)
            s.shell = undefined
            if (s.shellDecoder) {
              const tail = s.shellDecoder.decode()
              if (tail) this.handlers.onData(sessionId, tail)
              s.shellDecoder = undefined
            }
          })
        channel.stderr.on('data', (d: Buffer) => {
          this.handlers.onData(sessionId, dec.decode(d, { stream: true }))
        })

        // Best-effort OSC 7 cwd reporting for POSIX remotes so the file explorer
        // can follow `cd`. The hook must be wired per-shell: bash re-runs
        // PROMPT_COMMAND before each prompt, while zsh ignores it and instead
        // calls the functions in `precmd_functions`. We detect the live shell via
        // $ZSH_VERSION (set in the interactive shell, so more reliable than probing)
        // and append to whichever mechanism applies — preserving the distro's own
        // hooks and staying idempotent. Echo is suppressed so the setup line isn't
        // shown; we then clear and emit once for the initial cwd. (A plain sh/dash
        // login falls through to the bash branch, which it ignores, so only the
        // initial directory is reported — acceptable for that rare case.)
        if (s.context.os === 'linux' || s.context.os === 'mac') {
          // __dt7 emits OSC 7 (cwd). __dtA/__dtB are OSC 133 ;A/;B semantic-prompt
          // markers wrapped into PS1 (bash) / PROMPT (zsh) as non-printing regions
          // so the renderer knows where the typed command begins — the anchor the
          // history autocomplete reads from. Each wrap is guarded (case "*133*") so
          // it's idempotent and only applied to the shell that supports it.
          const setup =
            `stty -echo 2>/dev/null; ` +
            `__dt7() { printf '\\033]7;file://%s%s\\007' "\${HOSTNAME:-h}" "$PWD"; }; ` +
            `__dtA=$(printf '\\033]133;A\\007'); __dtB=$(printf '\\033]133;B\\007'); ` +
            `if [ -n "$ZSH_VERSION" ]; then ` +
            `case " \${precmd_functions[*]} " in *" __dt7 "*) ;; *) precmd_functions+=(__dt7);; esac; ` +
            `case "$PROMPT" in *133*) ;; *) PROMPT="%{$__dtA%}$PROMPT%{$__dtB%}";; esac; ` +
            `else ` +
            `case ":$PROMPT_COMMAND:" in *__dt7*) ;; *) PROMPT_COMMAND="__dt7\${PROMPT_COMMAND:+;$PROMPT_COMMAND}";; esac; ` +
            `if [ -n "$BASH_VERSION" ]; then case "$PS1" in *133*) ;; *) PS1="\\[$__dtA\\]$PS1\\[$__dtB\\]";; esac; fi; ` +
            `fi; ` +
            `stty echo 2>/dev/null; clear; __dt7\n`
          setTimeout(() => s.shell?.write(setup), 700)
        } else if (s.context.os === 'windows') {
          // Windows remote: probe whether the open shell is PowerShell (the
          // OpenSSH server default on Server 2019+ and most modern Windows
          // boxes). cmd.exe has no prompt hook that can emit OSC 7, so we
          // intentionally fall through to no-op there — see the limitation
          // note on `probeWindowsShell`. The setup is identical in shape to
          // the local PTY's PowerShell branch in `main/pty/manager.ts`
          // (function `prompt` writes the OSC 7 sequence and the OSC 133 ;A/;B
          // markers around the visible prompt).
          void probeWindowsShell(s.client).then((isPS) => {
            s.isWindowsPowerShell = isPS
            if (!isPS) return // cmd.exe: known limitation, no OSC 7.
            const setup =
              `function prompt { $e=[char]27; $b=[char]7; $p=$PWD.ProviderPath; ` +
              `$u=($p -replace '\\\\','/'); ` +
              `Write-Host -NoNewline ($e + ']133;A' + $b + $e + ']7;file:///' + $u + $b); ` +
              `('PS ' + $p + '> ' + $e + ']133;B' + $b) }; ` +
              `Clear-Host; prompt\n`
            setTimeout(() => s.shell?.write(setup), 700)
          })
        }
        resolve()
      })
    })
  }

  /**
   * Lazily open an SFTP channel on the session's EXISTING client (channel mux —
   * never a second connection), cached for reuse.
   */
  getSftp(sessionId: string): Promise<SFTPWrapper> {
    const s = this.sessions.get(sessionId)
    if (!s) return Promise.reject(new Error('unknown session'))
    if (s.sftp) return Promise.resolve(s.sftp)
    return new Promise((resolve, reject) => {
      s.client.sftp((err, sftp) => {
        if (err) return reject(err)
        s.sftp = sftp
        sftp.on('close', () => (s.sftp = undefined))
        resolve(sftp)
      })
    })
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
    return new Promise((resolve, reject) => {
      let settled = false
      const stdoutChunks: Buffer[] = []
      const stderrChunks: Buffer[] = []
      // Decode once on completion so multi-byte UTF-8 codepoints split across
      // ssh2 data chunks aren't turned into U+FFFD by per-chunk `.toString()`.
      const snapshot = () => ({
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8')
      })
      const finish = (r: { stdout: string; stderr: string; code: number | null; timedOut: boolean }) => {
        if (!settled) {
          settled = true
          resolve(r)
        }
      }
      const timer = setTimeout(
        () => finish({ ...snapshot(), code: null, timedOut: true }),
        timeoutMs
      )
      s.client.exec(command, (err, stream) => {
        if (err) {
          clearTimeout(timer)
          return reject(err)
        }
        stream
          .on('close', (c: number) => {
            clearTimeout(timer)
            finish({ ...snapshot(), code: c ?? null, timedOut: false })
          })
          .on('data', (d: Buffer) => stdoutChunks.push(d))
          .stderr.on('data', (d: Buffer) => stderrChunks.push(d))
      })
    })
  }

  input(sessionId: string, data: string): void {
    this.sessions.get(sessionId)?.shell?.write(data)
  }

  resize(sessionId: string, cols: number, rows: number): void {
    if (cols > 0 && rows > 0) this.sessions.get(sessionId)?.shell?.setWindow(rows, cols, 0, 0)
  }

  disconnect(sessionId: string): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    // Cancel any in-flight reconnect loop first so the close handler does
    // not race a new attempt. Use the same flag the close handler checks
    // (`s.reconnect`) — clearTimeout + delete it from the session record.
    if (s.reconnect) {
      clearTimeout(s.reconnect.timer)
      delete s.reconnect
    }
    // The placeholder session has no live client (`client === undefined`).
    if (s.client) {
      try {
        s.shell?.close()
        s.client.end()
        s.jump?.end()
      } catch {
        /* ignore */
      }
    }
    this.cleanup(sessionId)
  }

  private cleanup(sessionId: string): void {
    this.sessions.delete(sessionId)
  }

  disconnectAll(): void {
    for (const id of [...this.sessions.keys()]) this.disconnect(id)
  }
}
