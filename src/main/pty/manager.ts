import { randomUUID } from 'crypto'
import os from 'os'
import { existsSync } from 'fs'
import { dirname, join } from 'path'
import { createRequire } from 'node:module'
import * as pty from 'node-pty'
import type { IPty, IWindowsPtyForkOptions } from 'node-pty'
import type { PtyCreateOptions, PtyCreated } from '@shared/types'

export interface PtyHandlers {
  onData: (id: string, data: string) => void
  onExit: (id: string, exitCode: number | undefined, signal?: number) => void
}

/**
 * Startup args for the chosen shell. For PowerShell we inject a `prompt`
 * function that emits, on every prompt:
 *  - OSC 7 (file:// URI of $PWD) so the UI can track the working directory, and
 *  - OSC 133 ;A / ;B "semantic prompt" markers (FinalTerm/iTerm) so the renderer
 *    knows exactly where the prompt ends and the typed command begins — the
 *    anchor the history autocomplete popup reads from. ;A and ;B are non-printing
 *    so the visible prompt is unchanged.
 */
export function shellArgs(shell: string): string[] {
  if (/powershell|pwsh/i.test(shell)) {
    const promptFn =
      'function prompt { $e=[char]27; $b=[char]7; $p=$PWD.ProviderPath; ' +
      "$u=($p -replace '\\\\','/'); " +
      "Write-Host -NoNewline ($e + ']133;A' + $b + $e + ']7;file:///' + $u + $b); " +
      "('PS ' + $p + '> ' + $e + ']133;B' + $b) }"
    return ['-NoLogo', '-NoExit', '-Command', promptFn]
  }
  return []
}

/**
 * Pick a sensible default interactive shell for the current platform.
 * On Windows we prefer PowerShell (pwsh 7 if installed, else Windows PowerShell)
 * over cmd.exe so familiar commands like `ls`, `cd`, `pwd`, `cat` work.
 */
export function defaultShell(): string {
  if (process.platform === 'win32') {
    const pwsh7 = `${process.env.ProgramFiles}\\PowerShell\\7\\pwsh.exe`
    if (existsSync(pwsh7)) return pwsh7
    const winPs = `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
    if (existsSync(winPs)) return winPs
    return process.env.COMSPEC || 'cmd.exe'
  }
  return process.env.SHELL || '/bin/bash'
}

/**
 * Whether node-pty's bundled ConPTY dll is actually on disk. We prefer it (the
 * Windows Terminal ConPTY) over the in-box conhost copy for its TUI repaint /
 * teardown fixes, but the native conpty.node hard-throws "Cannot find
 * conpty.dll" if `build/Release/conpty/conpty.dll` is missing (e.g. a prebuilt
 * that didn't ship the folder, or a setup that didn't copy it). Resolve it via
 * node-pty's own module location so this is correct in dev and the asarUnpacked
 * packaged build alike, and degrade to the in-box ConPTY instead of crashing
 * every local-terminal spawn. `npm run setup` lays the dll down; this is the
 * runtime backstop.
 */
function bundledConptyAvailable(): boolean {
  if (process.platform !== 'win32') return false
  try {
    const ptyMain = createRequire(__filename).resolve('node-pty')
    return existsSync(join(dirname(ptyMain), '..', 'build', 'Release', 'conpty', 'conpty.dll'))
  } catch {
    return false
  }
}

// Resolved once — the dll is present (or not) for the whole process lifetime,
// and pty.create is hot.
const USE_CONPTY_DLL = bundledConptyAvailable()
if (process.platform === 'win32' && !USE_CONPTY_DLL) {
  console.warn(
    '[pty] bundled ConPTY dll not found (node-pty/build/Release/conpty/conpty.dll); ' +
      'falling back to the in-box ConPTY. Run `npm run setup` to restore it.'
  )
}

/**
 * Env vars forwarded from the parent process to every spawned child. KEEP
 * THIS LIST NARROW. node-pty previously forwarded the full `process.env` to
 * every local PTY (the agent's interactive CLI included), which silently
 * leaked the operator's `OPENAI_API_KEY`, `AWS_*`, `GITHUB_TOKEN`, etc. into
 * the embedded agent. The list below is the minimum the agent + a normal
 * interactive shell needs to find tools, locales, and a temp dir; provider
 * API keys are injected explicitly via `spec.env` in the launch layer.
 *
 * TERM / COLORTERM are forwarded because xterm.js sets them in the parent
 * and the child shell needs to see the same terminal type for things like
 * colored output and OSC 7 acceptance.
 */
const FORWARDED_ENV_KEYS = [
  'PATH',
  'Path', // Windows is case-insensitive but the env-block is uppercase
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LC_MESSAGES',
  'LANGUAGE',
  'TERM',
  'COLORTERM',
  'SHELL',
  'TMPDIR',
  'TMP',
  'TEMP',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'SSH_AUTH_SOCK'
] as const

function baseEnv(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const k of FORWARDED_ENV_KEYS) {
    const v = process.env[k]
    if (typeof v === 'string' && v.length > 0) out[k] = v
  }
  return out
}

/**
 * Owns local node-pty processes. Phase 1 spawns the local shell; later phases
 * (agent pane) spawn the interactive `pi` CLI through this same manager.
 */
export class PtyManager {
  private ptys = new Map<string, IPty>()

  constructor(private handlers: PtyHandlers) {}

  create(opts: PtyCreateOptions & { args?: string[]; env?: Record<string, string> }): PtyCreated {
    const shell = opts.shell || defaultShell()
    const id = randomUUID()
    // Explicit args (e.g. launching `pi`) bypass the default prompt-injection.
    const shellOnlyArgs = opts.args ?? shellArgs(shell)

    // Phase 2: when the renderer asked for a tmux session, wrap the user's
    // shell in `tmux -L devterm new-session -A -s <name> -x <cols> -y <rows>`.
    // `-A` attaches to the existing session (resume after app restart) or
    // creates a new one (first open). The inner shell is invoked exactly as
    // before so PowerShell still gets its OSC 7 prompt injection.
    //
    // We still spawn `tmux` through node-pty: node-pty owns the PTY master
    // (the size-handshake, the renderer-side data stream, the resize events),
    // and tmux owns the inner PTY to the user's shell. They cooperate cleanly.
    const tmuxSession = opts.tmuxSession
    let spawnShell: string
    let spawnArgs: string[]
    if (tmuxSession) {
      spawnShell = 'tmux'
      spawnArgs = [
        '-L',
        'devterm',
        'new-session',
        '-A',
        '-s',
        tmuxSession,
        '-x',
        String(opts.cols || 80),
        '-y',
        String(opts.rows || 24),
        shell,
        ...shellOnlyArgs
      ]
    } else {
      spawnShell = shell
      spawnArgs = shellOnlyArgs
    }

    const ptyOpts: IWindowsPtyForkOptions = {
      name: 'xterm-256color',
      cols: opts.cols || 80,
      rows: opts.rows || 24,
      cwd: opts.cwd || os.homedir(),
      // Curated env (see baseEnv) + per-spec overrides. Previously this was
      // `{ ...process.env, ...opts.env }`, which leaked the operator's
      // OPENAI_API_KEY / AWS_* / GITHUB_TOKEN etc. into every spawned
      // child — including the embedded agent CLI. Provider keys now come in
      // through `opts.env` (from the launch layer in src/main/agent/*).
      env: { ...baseEnv(), ...(opts.env ?? {}) },
      // Use the ConPTY bundled with node-pty (the Windows Terminal one) instead
      // of the in-box conhost ConPTY: the OS copy has known TUI repaint
      // corruption and teardown bugs, and the bundled-dll path also skips the
      // console-list agent that crashes when the console is already gone.
      // Falls back to the in-box ConPTY (USE_CONPTY_DLL=false) when the bundled
      // dll isn't on disk, rather than throwing. Ignored on non-Windows.
      useConptyDll: USE_CONPTY_DLL
    }
    const proc = pty.spawn(spawnShell, spawnArgs, ptyOpts)

    proc.onData((data) => this.handlers.onData(id, data))
    proc.onExit(({ exitCode, signal }) => {
      this.handlers.onExit(id, exitCode, signal)
      this.ptys.delete(id)
    })

    this.ptys.set(id, proc)
    return { id, shell: spawnShell, inTmux: !!tmuxSession }
  }

  // write/resize can throw (EPIPE et al.) when the process died but onExit
  // hasn't cleaned up yet — a no-op is the right outcome, not a crash.
  input(id: string, data: string): void {
    try {
      this.ptys.get(id)?.write(data)
    } catch {
      /* pty already dead */
    }
  }

  resize(id: string, cols: number, rows: number): void {
    const p = this.ptys.get(id)
    try {
      if (p && cols > 0 && rows > 0) p.resize(cols, rows)
    } catch {
      /* pty already dead */
    }
  }

  kill(id: string): void {
    const p = this.ptys.get(id)
    if (p) {
      try {
        p.kill()
      } catch {
        /* already gone */
      }
      this.ptys.delete(id)
    }
  }

  killAll(): void {
    for (const id of [...this.ptys.keys()]) this.kill(id)
  }
}
