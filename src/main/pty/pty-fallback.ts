import { spawn, type ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { win32 } from 'path'
import type { IPty, IWindowsPtyForkOptions } from 'node-pty'
import * as pty from 'node-pty'

/**
 * Windows Smart App Control / WDAC refuses to load DevTerm's unsigned
 * `conpty.node`. The file is already inside the installer; the policy blocks
 * the load, and every local shell then dies in `pty:create`. The inbox
 * `conhost.exe` is Microsoft-signed and present on every supported Windows
 * install, so a blocked native addon can still host a shell.
 */

export function ptyErrorText(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`
  return String(err)
}

/** True when node-pty failed because Windows would not load its native addon. */
export function shouldFallbackFromPtyError(err: unknown): boolean {
  const text = ptyErrorText(err)
  if (/application control policy has blocked this file/i.test(text)) return true
  if (/system integrity policy/i.test(text)) return true
  if (/ERR_DLOPEN_FAILED/i.test(text)) return true
  if (/cannot find module/i.test(text) && /(?:conpty|pty)\.node/i.test(text)) return true
  if (/cannot find conpty\.dll/i.test(text)) return true
  if (/specified module could not be found/i.test(text) && /\.node/i.test(text)) return true
  return false
}

/** Pull the blocked path out of Node's dlopen message, without the `\\?\` prefix. */
export function blockedNativePath(err: unknown): string | null {
  const text = ptyErrorText(err)
  const match =
    text.match(/\\\\+\?\\([A-Za-z]:\\[^\r\n]+)/) ??
    text.match(/([A-Za-z]:\\[^\r\n]+?\.(?:node|dll|exe))/)
  if (!match) return null
  return (match[1] ?? match[0]).trim()
}

export function inboxConsoleNotice(err: unknown): string {
  const path = blockedNativePath(err)
  const where = path ? ` (${path})` : ''
  return (
    `\r\n\x1b[33mWindows blocked DevTerm's terminal module${where}.\x1b[0m\r\n` +
    `\x1b[90mApplication Control refused that file. This shell is running through Windows' own console host, so commands still run on this PC. Full-screen programs and live resize can be limited.\x1b[0m\r\n\r\n`
  )
}

export interface InboxConsoleLaunch {
  file: string
  args: string[]
  via: 'conhost' | 'shell'
}

export function resolveInboxConsoleLaunch(input: {
  shell: string
  args: string[]
  systemRoot: string
  conhostExists: boolean
}): InboxConsoleLaunch {
  if (input.conhostExists) {
    return {
      file: win32.join(input.systemRoot, 'System32', 'conhost.exe'),
      args: [input.shell, ...input.args],
      via: 'conhost'
    }
  }
  return { file: input.shell, args: input.args, via: 'shell' }
}

/** Pipes have no console line discipline; Enter from xterm arrives as CR. */
export function windowsPipeInput(data: string): string {
  return data.replace(/\r\n|\n|\r/g, '\r\n')
}

function stringEnv(env: { [key: string]: string | undefined } | undefined): NodeJS.ProcessEnv {
  if (!env) return process.env
  const out: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') out[key] = value
  }
  return out
}

/**
 * A pipe-backed stand-in for node-pty. On Windows the child is `conhost.exe`
 * launching the operator's shell, which keeps console-mode programs working
 * without loading `conpty.node`.
 */
export function spawnPipePty(
  file: string,
  args: string[],
  options: IWindowsPtyForkOptions,
  spawnProcess: typeof spawn = spawn
): IPty {
  const child = spawnProcess(file, args, {
    cwd: options.cwd,
    env: stringEnv(options.env),
    windowsHide: true,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe']
  })
  return new PipePty(child, file)
}

class PipePty implements IPty {
  readonly pid: number
  readonly process: string
  private dataCb: ((data: string) => void) | null = null
  private exitCb: ((e: { exitCode: number | undefined; signal?: number }) => void) | null = null
  private exited = false

  constructor(
    private readonly child: ChildProcess,
    file: string
  ) {
    this.pid = typeof child.pid === 'number' ? child.pid : 0
    this.process = file
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => this.emit(chunk))
    child.stderr?.on('data', (chunk: string) => this.emit(chunk))
    child.on('error', () => this.finish(undefined))
    child.on('exit', (code) => this.finish(typeof code === 'number' ? code : undefined))
  }

  onData(cb: (data: string) => void): void {
    this.dataCb = cb
  }

  onExit(cb: (e: { exitCode: number | undefined; signal?: number }) => void): void {
    this.exitCb = cb
  }

  write(data: string): void {
    const payload = process.platform === 'win32' ? windowsPipeInput(data) : data
    try {
      this.child.stdin?.write(payload)
    } catch {
      /* pipe already closed */
    }
  }

  resize(_cols: number, _rows: number): void {
    // conhost's pipe session has no ConPTY resize ioctl. The shell keeps
    // the size it inherited at spawn.
  }

  kill(): void {
    try {
      this.child.kill()
    } catch {
      /* already gone */
    }
  }

  private emit(data: string): void {
    if (!data) return
    try {
      this.dataCb?.(data)
    } catch (err) {
      console.error('[pty] fallback data listener threw:', err)
    }
  }

  private finish(exitCode: number | undefined): void {
    if (this.exited) return
    this.exited = true
    try {
      this.exitCb?.({ exitCode, signal: undefined })
    } catch (err) {
      console.error('[pty] fallback exit listener threw:', err)
    }
  }
}

export interface OpenLocalPtyDeps {
  spawnNative?: typeof pty.spawn
  spawnPipe?: (file: string, args: string[], options: IWindowsPtyForkOptions) => IPty
  platform?: NodeJS.Platform
  systemRoot?: string
  conhostExists?: (path: string) => boolean
}

export function openLocalPty(
  shell: string,
  args: string[],
  ptyOpts: IWindowsPtyForkOptions,
  deps: OpenLocalPtyDeps = {}
): { proc: IPty; notice?: string } {
  const spawnNative = deps.spawnNative ?? pty.spawn
  try {
    return { proc: spawnNative(shell, args, ptyOpts) }
  } catch (err) {
    const platform = deps.platform ?? process.platform
    if (platform !== 'win32' || !shouldFallbackFromPtyError(err)) throw err
    const systemRoot = deps.systemRoot ?? process.env.SystemRoot ?? 'C:\\Windows'
    const conhostPath = win32.join(systemRoot, 'System32', 'conhost.exe')
    const exists = deps.conhostExists ?? existsSync
    const launch = resolveInboxConsoleLaunch({
      shell,
      args,
      systemRoot,
      conhostExists: exists(conhostPath)
    })
    console.warn(
      `[pty] native terminal blocked (${ptyErrorText(err)}). Starting ${shell} via ${launch.file}.`
    )
    const spawnPipe =
      deps.spawnPipe ?? ((file, fileArgs, options) => spawnPipePty(file, fileArgs, options))
    return { proc: spawnPipe(launch.file, launch.args, ptyOpts), notice: inboxConsoleNotice(err) }
  }
}
