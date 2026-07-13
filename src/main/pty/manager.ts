import { randomUUID } from 'crypto'
import os from 'os'
import { existsSync } from 'fs'
import { dirname, join } from 'path'
import { createRequire } from 'node:module'
import * as pty from 'node-pty'
import type { IPty, IWindowsPtyForkOptions } from 'node-pty'
import type {
  DefaultShellPref,
  PtyCreateOptions,
  PtyCreated,
  PtyStartupFailure
} from '@shared/types'

export interface PtyHandlers {
  onData: (id: string, data: string) => void
  onExit: (id: string, exitCode: number | undefined, signal?: number) => void
  /**
   * Fires at most once per spawn when the PTY exits without ever producing
   * data — the "Windows PowerShell 5.1 failed to start" signature pattern.
   * Optional; older callers omit it. Always paired with `onExit`, never in
   * place of it.
   */
  onStartupFailure?: (id: string, info: PtyStartupFailure) => void
}

/** Listener registered via `addExitListener`; called when a specific PTY exits. */
export type PtyExitListener = (exitCode: number | undefined, signal?: number) => void

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
 *
 * On Windows we strongly prefer PowerShell 7 (`pwsh.exe`) — it doesn't have
 * Windows PowerShell 5.1's managed-assembly signature check, which trips
 * (0x8009001d / `NTE_BAD_SIGNATURE`) on boxes where antivirus has tampered
 * with the PS DLLs or the .NET Framework install is broken. PowerShell 7
 * also gives a real cross-platform shell with PSReadLine, oh-my-posh,
 * and modern module support.
 *
 * If only Windows PowerShell 5.1 is on the box, that's the next pick —
 * the startup-failure diagnostic in PtyManager.create detects the 0x8009001d
 * case (and any other "process exited before producing data" case) and
 * pushes a `pty:startup-failure` IPC so the renderer can show a targeted
 * fix instead of a generic "[process exited]".
 *
 * As a last resort on Windows we use `%COMSPEC%` (cmd.exe). On non-Windows
 * we use `$SHELL`.
 */
export function defaultShell(): string {
  if (process.platform === 'win32') {
    for (const p of pwshCandidatePaths()) {
      if (existsSync(p)) return p
    }
    const winPs = join(
      process.env.SystemRoot ?? 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe'
    )
    if (existsSync(winPs)) return winPs
    return process.env.COMSPEC || 'cmd.exe'
  }
  return process.env.SHELL || '/bin/bash'
}

/**
 * Every realistic install location for PowerShell 7. Checked in order; the
 * first hit wins. We can't use the registry without an extra async call, so
 * we sample the well-known filesystem paths — they cover the Microsoft
 * Store, MSI (`%ProgramFiles%`), and per-user (`%LOCALAPPDATA%`) installs.
 * Powershell 7 has been at `PowerShell\7\pwsh.exe` since GA.
 */
function pwshCandidatePaths(): string[] {
  if (process.platform !== 'win32') return []
  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files'
  const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
  const localAppData = process.env.LOCALAPPDATA ?? ''
  return [
    // The Microsoft Store / "Windows Store Edition" install — its root path
    // varies, so we just check the well-known alias location.
    join(localAppData, 'Microsoft', 'WindowsApps', 'pwsh.exe'),
    // Per-user install (most common for the standalone MSI).
    join(localAppData, 'Microsoft', 'PowerShell', '7', 'pwsh.exe'),
    // System-wide MSI install (machine-wide, the default).
    join(programFiles, 'PowerShell', '7', 'pwsh.exe'),
    join(programFilesX86, 'PowerShell', '7', 'pwsh.exe')
  ].filter((p) => p.length > 0)
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
 * Whether a PTY data chunk carries actual shell output, as opposed to just the
 * terminal-mode handshake ConPTY emits on every spawn before the shell runs.
 *
 * ConPTY's pre-shell prefix is pure ANSI: `ESC[1t ESC[c ESC[?1004h ESC[?9001h`
 * (title mode, DA1, focus reporting, VT input mode) — no printable bytes. A
 * healthy shell adds a prompt or banner behind that handshake. The
 * startup-failure diagnostic needs "did the shell ever render anything?", so we
 * strip OSC/CSI escape sequences and control bytes and ask whether anything
 * printable survives. The strip is deliberately cheap (one regex pass) since it
 * runs on the first few chunks of every spawn.
 */
const ANSI_OR_CTRL = /\x1b\][^\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?<=>]*[!-/]*[@-~]|[\x00-\x1f\x7f]/g
function hasRealOutput(data: string): boolean {
  return data.replace(ANSI_OR_CTRL, '').length > 0
}

/**
 * Owns local node-pty processes. Phase 1 spawns the local shell; later phases
 * (agent pane) spawn the interactive `pi` CLI through this same manager.
 */
export class PtyManager {
  private ptys = new Map<string, IPty>()
  /**
   * Per-id exit listeners. The agent IPC subscribes here so an agent PTY
   * exit can tear down the MCP bridge + temp dir immediately instead of
   * leaving them orphaned until the user manually closes the pane.
   */
  private exitListeners = new Map<string, Set<PtyExitListener>>()

  constructor(private handlers: PtyHandlers) {}

  /**
   * Subscribe to the exit of a single PTY. Returns a disposer. Fired from
   * the same `proc.onExit` callback as `handlers.onExit`, in addition.
   */
  addExitListener(id: string, cb: PtyExitListener): () => void {
    let set = this.exitListeners.get(id)
    if (!set) {
      set = new Set()
      this.exitListeners.set(id, set)
    }
    set.add(cb)
    return () => {
      const s = this.exitListeners.get(id)
      if (!s) return
      s.delete(cb)
      if (s.size === 0) this.exitListeners.delete(id)
    }
  }

  create(opts: PtyCreateOptions & { args?: string[]; env?: Record<string, string> }): PtyCreated {
    const shell = resolveShell(opts.shellPref, opts.shell)
    const id = randomUUID()
    // Explicit args (e.g. launching `pi`) bypass the default prompt-injection.
    const args = opts.args ?? shellArgs(shell)
    // Inherit the OS environment but strip Electron/node-specific variables so
    // user shells don't detect/depend on the app runtime.
    const baseEnv: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) {
      if (v == null) continue
      if (k.startsWith('ELECTRON_') || k.startsWith('NODE_') || k === 'VITE_DEV_SERVER_URL')
        continue
      baseEnv[k] = v
    }
    const cwd = opts.cwd || os.homedir()
    const ptyOpts: IWindowsPtyForkOptions = {
      name: 'xterm-256color',
      cols: opts.cols || 80,
      rows: opts.rows || 24,
      cwd,
      env: { ...baseEnv, ...(opts.env ?? {}) },
      // Use the ConPTY bundled with node-pty (the Windows Terminal one) instead
      // of the in-box conhost ConPTY: the OS copy has known TUI repaint
      // corruption and teardown bugs, and the bundled-dll path also skips the
      // console-list agent that crashes when the console is already gone.
      // Falls back to the in-box ConPTY (USE_CONPTY_DLL=false) when the bundled
      // dll isn't on disk, rather than throwing. Ignored on non-Windows.
      useConptyDll: USE_CONPTY_DLL
    }
    const proc = pty.spawn(shell, args, ptyOpts)

    // Startup-failure diagnostic: if the shell exits before emitting any *real*
    // output (Windows PowerShell 5.1's 0x8009001d is the canonical case — the
    // process dies during managed-DLL load, before its prompt can render), emit
    // a dedicated event so the renderer can show "Windows PowerShell failed to
    // start — install PowerShell 7" instead of the generic exit banner. The
    // regular `onData` / `onExit` handlers still run; this is in addition.
    //
    // "Real" output matters because ConPTY itself emits a fixed mode-setting
    // handshake (`ESC[1t ESC[c ESC[?1004h ESC[?9001h`) on every spawn BEFORE the
    // shell runs. When the shell then dies without ever rendering a prompt (the
    // signature failure), that handshake is the ONLY data on the stream — and
    // the naive "any onData ⇒ healthy" check would mark it healthy, masking the
    // failure so the user just sees the generic "[process exited with code 1]".
    // We strip ANSI escapes + control bytes and only declare healthy once some
    // printable shell output survives.
    //
    // Note: there is intentionally NO "auto-healthy after N ms" timer. A shell
    // that produced only the ConPTY prefix for several seconds and then exited
    // is still a startup failure (the prompt never rendered); a fixed timeout
    // that declared healthy would re-mask exactly the case this catches. The
    // health flag flips only on real output; an exit without it is the failure.
    let healthHealthy = false

    proc.onData((data) => {
      if (!healthHealthy && hasRealOutput(data)) healthHealthy = true
      this.handlers.onData(id, data)
    })
    proc.onExit(({ exitCode, signal }) => {
      // If we never saw real output, this is a startup failure — surface it.
      if (!healthHealthy && this.handlers.onStartupFailure) {
        this.handlers.onStartupFailure(id, { shell, exitCode, signal })
      }
      this.handlers.onExit(id, exitCode, signal)
      this.ptys.delete(id)
      const set = this.exitListeners.get(id)
      if (set) {
        this.exitListeners.delete(id)
        for (const cb of set) {
          try {
            cb(exitCode, signal)
          } catch (err) {
            console.error('[pty] exit listener threw:', err)
          }
        }
      }
    })

    this.ptys.set(id, proc)
    return { id, shell, cwd }
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

/**
 * Map a renderer's `shellPref` (or explicit `shell` override) to an absolute
 * path. The precedence is:
 *  - explicit `opts.shell` (a one-off override — the user picked this shell
 *    for THIS terminal from the new-terminal picker);
 *  - `opts.shellPref`: respects the user's setting, but only if the chosen
 *    shell is actually installed. A user-set PowerShell 7 on a box that only
 *    has 5.1 still falls back gracefully;
 *  - defaultShell() — best installed shell on this OS.
 *
 * Returns the resolved path (never throws). The startup-failure diagnostic in
 * `create()` catches the case where a non-empty `custom` path points at a
 * missing/broken executable and reports it instead of crashing silently.
 */
export function resolveShell(pref: DefaultShellPref | undefined, explicit?: string): string {
  if (explicit) return explicit
  if (pref) {
    switch (pref.kind) {
      case 'custom':
        if (pref.path) return pref.path
        break
      case 'pwsh':
        for (const p of pwshCandidatePaths()) if (existsSync(p)) return p
        break
      case 'powershell':
        return defaultShell().includes('WindowsPowerShell')
          ? defaultShell()
          : join(
              process.env.SystemRoot ?? 'C:\\Windows',
              'System32',
              'WindowsPowerShell',
              'v1.0',
              'powershell.exe'
            )
      case 'cmd':
        return process.env.COMSPEC || 'cmd.exe'
      case 'auto':
        break
    }
  }
  return defaultShell()
}
