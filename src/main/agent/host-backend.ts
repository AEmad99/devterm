import type { ChildProcess } from 'child_process'
import { exec } from 'child_process'
import { promises as fs } from 'fs'
import os from 'os'
import type { DirListing, FileEntry, HostContext } from '@shared/types'
import { listLocal } from '../fs/local'
import type { SSHManager } from '../ssh/manager'

/**
 * Host operations abstraction behind the five MCP host tools.
 *
 * Remote sessions wrap the session's ssh2 client (shell/SFTP/exec channels);
 * local sessions run on the workstation itself via child_process + fs. The
 * DevTerm Agent is therefore identical on both surfaces — same tool surface,
 * same policy boundary, different transport.
 */

export interface HostExecResult {
  stdout: string
  stderr: string
  code: number | null
  timedOut: boolean
}

export interface HostListEntry {
  name: string
  isDir: boolean
  size: number
  mode: string
}

export interface HostListing {
  path: string
  entries: HostListEntry[]
}

export interface HostReadResult {
  data: Buffer
  /** True when content continues past `maxBytes`. */
  truncated: boolean
}

export interface HostBackend {
  readonly kind: 'local' | 'remote'
  /**
   * Run `command`. `cwd` is only meaningful for the local backend (it sets
   * child_process's working directory); remote SSH exec channels always start
   * in the login default and are `cd`-prefixed by the caller instead.
   */
  exec(command: string, timeoutMs: number, cwd?: string): Promise<HostExecResult>
  listDir(path: string): Promise<HostListing>
  readFile(path: string, maxBytes: number): Promise<HostReadResult>
  writeFile(path: string, content: string): Promise<void>
  /** True while the transport is down/reconnecting (never true locally). */
  down(): boolean
}

function mapListing(l: DirListing): HostListing {
  const pick = (e: FileEntry): HostListEntry => ({
    name: e.name,
    isDir: e.isDir,
    size: e.size,
    mode: e.mode
  })
  return { path: l.path, entries: l.entries.map(pick) }
}

/** Remote backend over one SSH session's channels (same client as the shell). */
export class SshHostBackend implements HostBackend {
  readonly kind = 'remote' as const
  constructor(
    private ssh: SSHManager,
    private sessionId: string,
    /**
     * Down-state probe. Injected because the manager doesn't expose one:
     * ipc/agent.ts already tracks closed/reconnecting per session for the
     * bridge status mirror, so it supplies that here.
     */
    private isDown: () => boolean = () => false
  ) {}

  async exec(command: string, timeoutMs: number, _cwd?: string): Promise<HostExecResult> {
    return this.ssh.exec(this.sessionId, command, timeoutMs)
  }

  async listDir(path: string): Promise<HostListing> {
    const sftp = await this.ssh.getSftp(this.sessionId)
    return mapListing(await import('../ssh/sftp').then((m) => m.listRemote(sftp, path)))
  }

  /**
   * Read at most `maxBytes + 1` through an explicit SFTP handle so a huge
   * file never crosses the wire whole; the extra byte reports truncation.
   */
  async readFile(path: string, maxBytes: number): Promise<HostReadResult> {
    const sftp = await this.ssh.getSftp(this.sessionId)
    return new Promise<HostReadResult>((resolve, reject) => {
      sftp.open(path, 'r', (openErr, handle) => {
        if (openErr) return reject(openErr)
        const buf = Buffer.alloc(maxBytes + 1)
        sftp.read(handle, buf, 0, maxBytes + 1, 0, (readErr, bytesRead) => {
          sftp.close(handle, () => {
            /* best-effort close; surface the read result either way */
          })
          if (readErr) return reject(readErr)
          resolve({ data: buf.subarray(0, bytesRead), truncated: bytesRead > maxBytes })
        })
      })
    })
  }

  async writeFile(path: string, content: string): Promise<void> {
    const sftp = await this.ssh.getSftp(this.sessionId)
    await new Promise<void>((resolve, reject) =>
      sftp.writeFile(path, content, (err) => (err ? reject(err) : resolve()))
    )
  }

  down(): boolean {
    return this.isDown()
  }
}

/** Local backend: the workstation itself. */
export class LocalHostBackend implements HostBackend {
  readonly kind = 'local' as const

  async exec(command: string, timeoutMs: number, cwd?: string): Promise<HostExecResult> {
    // Shell-string execution matches run_command semantics on remote hosts
    // (the command line is whatever the operator would have typed). On
    // timeout we kill the child but report it as TIMED OUT — like the SSH
    // path, the process may keep running locally afterwards. `cwd` makes the
    // command run in the operator's current terminal directory, mirroring how
    // a command typed at the shell prompt would behave.
    let timedOut = false
    return new Promise((resolve) => {
      const child: ChildProcess = exec(
        command,
        { maxBuffer: 8 * 1024 * 1024, windowsHide: true, cwd },
        (err, stdout, stderr) => {
          clearTimeout(killTimer)
          const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0
          resolve({
            stdout: String(stdout ?? ''),
            stderr: String(stderr ?? ''),
            code,
            timedOut
          })
        }
      )
      const killTimer = setTimeout(() => {
        timedOut = true
        try {
          child.kill()
        } catch {
          /* already gone */
        }
      }, timeoutMs)
    })
  }

  async listDir(path: string): Promise<HostListing> {
    return mapListing(await listLocal(path))
  }

  async readFile(path: string, maxBytes: number): Promise<HostReadResult> {
    const handle = await fs.open(path, 'r')
    try {
      const buf = Buffer.alloc(maxBytes + 1)
      const { bytesRead } = await handle.read(buf, 0, maxBytes + 1, 0)
      return { data: buf.subarray(0, bytesRead), truncated: bytesRead > maxBytes }
    } finally {
      await handle.close()
    }
  }

  async writeFile(path: string, content: string): Promise<void> {
    await fs.writeFile(path, content, 'utf-8')
  }

  down(): boolean {
    return false
  }
}

export function localContext(): HostContext {
  const osName: HostContext['os'] =
    process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux'
  return {
    kind: 'local',
    os: osName,
    detail: `${os.type()} ${os.release()} (${os.arch()})`,
    hostname: os.hostname()
  }
}
