import { randomUUID } from 'crypto'
import os from 'os'
import * as pty from 'node-pty'
import type { IPty } from 'node-pty'
import type { PtyCreateOptions, PtyCreated } from '@shared/types'

export interface PtyHandlers {
  onData: (id: string, data: string) => void
  onExit: (id: string, exitCode: number, signal?: number) => void
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
      "function prompt { $e=[char]27; $b=[char]7; $p=$PWD.ProviderPath; " +
      "$u=($p -replace '\\\\','/'); " +
      "Write-Host -NoNewline ($e + ']133;A' + $b + $e + ']7;file:///' + $u + $b); " +
      "('PS ' + $p + '> ' + $e + ']133;B' + $b) }"
    return ['-NoLogo', '-NoExit', '-Command', promptFn]
  }
  return []
}

import { existsSync } from 'fs'

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
 * Owns local node-pty processes. Phase 1 spawns the local shell; later phases
 * (Claude pane) will spawn the interactive `claude` CLI through this same manager.
 */
export class PtyManager {
  private ptys = new Map<string, IPty>()

  constructor(private handlers: PtyHandlers) {}

  create(opts: PtyCreateOptions & { args?: string[]; env?: Record<string, string> }): PtyCreated {
    const shell = opts.shell || defaultShell()
    const id = randomUUID()
    // Explicit args (e.g. launching `claude`) bypass the default prompt-injection.
    const args = opts.args ?? shellArgs(shell)
    const proc = pty.spawn(shell, args, {
      name: 'xterm-256color',
      cols: opts.cols || 80,
      rows: opts.rows || 24,
      cwd: opts.cwd || os.homedir(),
      env: { ...(process.env as Record<string, string>), ...(opts.env ?? {}) }
    })

    proc.onData((data) => this.handlers.onData(id, data))
    proc.onExit(({ exitCode, signal }) => {
      this.handlers.onExit(id, exitCode, signal)
      this.ptys.delete(id)
    })

    this.ptys.set(id, proc)
    return { id, shell }
  }

  input(id: string, data: string): void {
    this.ptys.get(id)?.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    const p = this.ptys.get(id)
    if (p && cols > 0 && rows > 0) p.resize(cols, rows)
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
