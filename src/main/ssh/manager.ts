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
  sftp?: SFTPWrapper
  context: HostContext
}

export interface SSHHandlers {
  onData: (sessionId: string, data: string) => void
  onExit: (sessionId: string) => void
  onStatus: (sessionId: string, status: SSHStatus) => void
}

/**
 * Owns SSH sessions. One ssh2 client per session; the human shell is one
 * channel on it (SFTP and the MCP bridge will open further channels on the
 * SAME client in later phases — never a second connection).
 */
export class SSHManager {
  private sessions = new Map<string, Session>()

  constructor(private handlers: SSHHandlers) {}

  async connect(profile: SSHProfile): Promise<SSHConnectResult> {
    const id = profile.id || randomUUID()
    const onStatus = (s: SSHStatus) => this.handlers.onStatus(id, s)

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
      this.cleanup(id)
    })

    const context = await detectRemoteContext(client)
    this.sessions.set(id, { id, client, jump, context })
    return { sessionId: id, context }
  }

  openShell(sessionId: string, cols: number, rows: number): Promise<void> {
    const s = this.sessions.get(sessionId)
    if (!s) return Promise.reject(new Error('unknown session'))
    if (s.shell) return Promise.resolve()
    return new Promise((resolve, reject) => {
      s.client.shell({ term: 'xterm-256color', cols, rows }, (err, channel) => {
        if (err) return reject(err)
        s.shell = channel
        channel
          .on('data', (d: Buffer) => this.handlers.onData(sessionId, d.toString()))
          .on('close', () => {
            this.handlers.onExit(sessionId)
            s.shell = undefined
          })
        channel.stderr.on('data', (d: Buffer) => this.handlers.onData(sessionId, d.toString()))

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
          const setup =
            `stty -echo 2>/dev/null; ` +
            `__dt7() { printf '\\033]7;file://%s%s\\007' "\${HOSTNAME:-h}" "$PWD"; }; ` +
            `if [ -n "$ZSH_VERSION" ]; then ` +
            `case " \${precmd_functions[*]} " in *" __dt7 "*) ;; *) precmd_functions+=(__dt7);; esac; ` +
            `else ` +
            `case ":$PROMPT_COMMAND:" in *__dt7*) ;; *) PROMPT_COMMAND="__dt7\${PROMPT_COMMAND:+;$PROMPT_COMMAND}";; esac; ` +
            `fi; ` +
            `stty echo 2>/dev/null; clear; __dt7\n`
          setTimeout(() => s.shell?.write(setup), 700)
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
      let stdout = ''
      let stderr = ''
      let code: number | null = null
      const finish = (r: { stdout: string; stderr: string; code: number | null; timedOut: boolean }) => {
        if (!settled) {
          settled = true
          resolve(r)
        }
      }
      const timer = setTimeout(() => finish({ stdout, stderr, code: null, timedOut: true }), timeoutMs)
      s.client.exec(command, (err, stream) => {
        if (err) {
          clearTimeout(timer)
          return reject(err)
        }
        stream
          .on('close', (c: number) => {
            clearTimeout(timer)
            finish({ stdout, stderr, code: c ?? code, timedOut: false })
          })
          .on('data', (d: Buffer) => (stdout += d.toString()))
          .stderr.on('data', (d: Buffer) => (stderr += d.toString()))
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
    try {
      s.shell?.close()
      s.client.end()
      s.jump?.end()
    } catch {
      /* ignore */
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
