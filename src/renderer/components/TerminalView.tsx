import { memo, useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import type { ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { useSessions, type Session } from '../store/sessions'
import { useSettings, type TerminalBg } from '../store/settings'
import { getTheme, xtermTheme, terminalHostColor, type Theme } from '../lib/themes'
import { parseOsc7 } from '../lib/osc7'
import { createIdleChime, isAgentCommand, AGENT_ATTENTION_BODY } from '../lib/attention'
import { fitNow, fitSoon } from '../lib/fit'
import { attachRenderer, attachClipboard } from '../lib/renderer'
import { matchHotkey } from '../lib/hotkeys'
import { registerTerminal, registerTerminalInput, unregisterTerminal } from '../lib/terms'
import SearchBar from './SearchBar'
import Autosuggest from './Autosuggest'
import { attachAutosuggest, type AutosuggestController, type SuggestView } from '../lib/autosuggest'

// A TUI that dies without cleaning up (e.g. opencode killing its whole console
// on Ctrl+C — sst/opencode#6189) leaves xterm stuck in alternate-screen, mouse
// reporting, and hidden-cursor modes; an exit notice written then lands
// overlapped on the stale TUI frame. Restore sane modes before printing it.
const EXIT_RESET =
  '\x1b[?1049l' + // leave the alternate screen buffer
  '\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l' + // mouse reporting off
  '\x1b[?2004l' + // bracketed paste off
  '\x1b[?1004l' + // focus reporting off
  '\x1b[0m' + // reset colors/attributes
  '\x1b[?25h' // show the cursor

/** True for any path under the in-box Windows PowerShell 5.1 install —
 * the only shell DevTerm has a specific diagnostic for. */
function isWindowsPowerShellPath(p: string): boolean {
  return /[\\/]WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/i.test(p)
}

/** ANSI-colored, terminal-friendly diagnostic for Windows PowerShell 5.1's
 * classic managed-signature failure (NTSTATUS 0x8009001d). The banner is
 * written straight into xterm — the user can copy any line with the cursor.
 * The "Install PowerShell 7" copy is the recommended fix because PowerShell
 * 7 (pwsh.exe) ships its own managed runtime and doesn't trip the same
 * signature check; it's a single `winget install` away. */
function powershellFailureHelp(): string {
  return [
    '',
    '\x1b[33mWindows PowerShell failed to start.\x1b[0m',
    '\x1b[90mThis is almost always a managed-assembly signature failure\x1b[0m',
    '\x1b[90m(0x8009001d / NTE_BAD_SIGNATURE) — commonly caused by antivirus\x1b[0m',
    '\x1b[90mquarantining a PowerShell DLL, a corrupted .NET Framework install,\x1b[0m',
    '\x1b[90mor an out-of-sync system clock.\x1b[0m',
    '',
    '\x1b[36mRecommended fix — install PowerShell 7:\x1b[0m',
    '  winget install Microsoft.PowerShell',
    '',
    '\x1b[90mThen either:\x1b[0m',
    '  1. open a new terminal (DevTerm auto-detects pwsh.exe), or',
    '  2. Settings \u2192 General \u2192 Default local shell \u2192 PowerShell 7',
    '',
    '\x1b[90mIf you need Windows PowerShell back, repair the .NET Framework:\x1b[0m',
    '  DISM /Online /Cleanup-Image /RestoreHealth',
    '  sfc /scannow',
    ''
  ].join('\r\n') + '\r\n'
}

/** Fallback diagnostic for any other "shell exited before first prompt" case.
 * Less specific — covers wsl.exe pointing at a missing distro, a `custom`
 * shell path that's wrong, a 32/64-bit mismatch, etc. */
function genericFailureHelp(shell: string): string {
  return [
    '',
    '\x1b[33mThe shell exited before producing any output.\x1b[0m',
    `\x1b[90m  Path: ${shell}\x1b[0m`,
    '\x1b[90mCommon causes: missing executable, broken symlink, or a\x1b[0m',
    '\x1b[90m32/64-bit mismatch. Settings \u2192 General \u2192 Default local shell\x1b[0m',
    '\x1b[90mcan pick a different shell (cmd.exe, PowerShell 7, custom path).\x1b[0m',
    ''
  ].join('\r\n') + '\r\n'
}

/** Apply the user's background settings to the terminal host element (image + dim + colour). */
function applyHostBg(host: HTMLElement, bg: TerminalBg, theme: Theme): void {
  host.style.backgroundColor = terminalHostColor(theme)
  if (bg.image) {
    const d = Math.max(0, Math.min(0.85, bg.dim))
    host.style.backgroundImage = `linear-gradient(rgba(0,0,0,${d}),rgba(0,0,0,${d})), url("${bg.image}")`
    host.style.backgroundSize = 'cover'
    host.style.backgroundPosition = 'center'
    host.style.backgroundRepeat = 'no-repeat'
  } else {
    host.style.backgroundImage = ''
  }
}

/**
 * One terminal pane bound to a session. Local sessions create a node-pty;
 * remote sessions open a shell channel on the existing ssh2 client. The same
 * xterm wiring serves both (Trap §8: WebGL is feature-detected with fallback).
 */
function TerminalView({ session }: { session: Session }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const searchRef = useRef<SearchAddon | null>(null)
  // The current backend resize fn (pty or ssh), set once the session is wired.
  // Used to push a resize after a font change (which alters cols/rows without
  // changing the host's pixel size, so the ResizeObserver wouldn't fire).
  const resizeRef = useRef<((cols: number, rows: number) => void) | null>(null)
  const [findOpen, setFindOpen] = useState(false)
  const [suggestView, setSuggestView] = useState<SuggestView | null>(null)
  const suggestRef = useRef<AutosuggestController | null>(null)
  // Cached bell setting, refreshed by the prefs effect below. Read on every PTY
  // data chunk by writeData — a `useSettings.getState()` per chunk is cheap but
  // compounds on a fast stream, and the chunk path is one of the few that runs
  // in tight loops. Cache once, update on the existing prefs effect. Seed the
  // ref with the current setting so the main effect's writeData closure sees
  // the right value before the prefs effect's first run.
  const bellOnRef = useRef(useSettings.getState().prefs.bell === 'visual')

  useEffect(() => {
    const host = hostRef.current
    // Browser panes never render here (TerminalLayout routes them to BrowserPane);
    // bail defensively so a future misroute can't spawn a pty/ssh for one.
    if (!host || session.id.startsWith('pending-') || session.kind === 'browser') return

    const { terminalBg: bg, prefs, themeId } = useSettings.getState()
    const theme = getTheme(themeId)
    const baseTheme: ITheme = xtermTheme(theme, bg)
    const term = new Terminal({
      fontFamily: prefs.fontFamily,
      fontSize: prefs.fontSize,
      lineHeight: prefs.lineHeight,
      cursorStyle: prefs.cursorStyle,
      cursorBlink: prefs.cursorBlink,
      scrollback: prefs.scrollback,
      scrollSensitivity: prefs.scrollSensitivity,
      allowProposedApi: true,
      allowTransparency: true,
      theme: baseTheme
    })
    termRef.current = term
    applyHostBg(host, bg, theme)
    const fit = new FitAddon()
    term.loadAddon(fit)
    fitRef.current = fit
    const search = new SearchAddon()
    term.loadAddon(search)
    searchRef.current = search
    term.loadAddon(new WebLinksAddon())
    term.open(host)
    registerTerminal(session.id, term)
    const disposeRenderer = attachRenderer(term)
    const disposeClipboard = attachClipboard(term, host)

    // History autocomplete: track the OSC 133 prompt anchor and surface a
    // completion popup. `sendInput` is wired once the pty/ssh backend is known.
    // Registered so snippets/the palette can write to this shell by session id
    // (the local pty id is private to this effect).
    let sendInput: (data: string) => void = () => {}
    registerTerminalInput(session.id, (d) => sendInput(d))
    const suggest = attachAutosuggest(term, host, {
      query:
        session.kind === 'remote' ? { scope: 'remote', sessionId: session.id } : { scope: 'local' },
      send: (d) => sendInput(d),
      onChange: setSuggestView
    })
    suggestRef.current = suggest

    // Single custom key handler (xterm allows only one). Handles copy/paste, the
    // find bar, and blocks app hotkeys (Ctrl/Cmd+K …) from reaching the shell as
    // control bytes (e.g. `^K`) — the DOM event still bubbles to App's listener.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true
      // The autocomplete popup gets first crack at Tab/→/Esc while it's open.
      if (suggest.handleKey(e)) return false
      const k = e.key.toLowerCase()
      // Primary copy chord on Windows: Ctrl+Shift+C always copies. This is
      // unconditional (not selection-gated) because Ctrl+Shift+C never sends
      // a control byte to the shell — it's the dedicated copy binding.
      if (e.ctrlKey && e.shiftKey && !e.altKey && k === 'c') {
        e.preventDefault()
        if (term.hasSelection()) window.devterm.clipboard.writeText(term.getSelection())
        return false
      }
      // Paste chords (Ctrl+Shift+V / Ctrl+V / Cmd+V). All three route through
      // the capture-phase `paste` listener in attachClipboard; we only stop
      // xterm from emitting the control byte — crucially we do NOT
      // preventDefault, so the native paste event still reaches that listener.
      // Returning false keeps xterm's own paste handler (which double-fires in
      // the sandboxed renderer) from running.
      if (
        !e.altKey &&
        !e.shiftKey &&
        ((e.ctrlKey && k === 'v') || (e.metaKey && k === 'v'))
      ) {
        return false
      }
      // Copy-or-SIGINT on Ctrl+C / Cmd+C. With text selected, copy and swallow
      // the chord; otherwise let xterm send \x03 (SIGINT) as every other
      // terminal does. This is the binding Windows Terminal / VS Code ship and
      // is the primary reason "copy doesn't work" got reported — Ctrl+C used
      // to always send SIGINT.
      if (
        !e.altKey &&
        !e.shiftKey &&
        ((e.ctrlKey && k === 'c') || (e.metaKey && k === 'c'))
      ) {
        if (term.hasSelection()) {
          e.preventDefault()
          window.devterm.clipboard.writeText(term.getSelection())
          return false
        }
        // No selection: let xterm handle (it sends \x03 for SIGINT).
        return true
      }
      const id = matchHotkey(e)
      if (id === 'find') {
        setFindOpen(true)
        return false
      }
      return id === null
    })

    // Inline-agent attention: when an agent command (claude / codex / aider /
    // pi / gemini / opencode / goose / crush / kiro, etc.) is launched in THIS
    // shell, watch it for "finished / waiting" — its output going quiet for a
    // beat after a real burst — until the shell prompt returns. A plain shell,
    // a quick command, or a long build never arms this; only an actual agent
    // does. The list of recognized agents lives in lib/attention.ts.
    const idleChime = createIdleChime({
      sessionId: session.id,
      makeNotice: () => ({ title: session.title, body: AGENT_ATTENTION_BODY })
    })
    // Reconstruct the command being submitted so we can spot an agent launch.
    // Keystrokes are exact for a typed command; on Enter we also read the rendered
    // prompt line, which catches a history-recalled or autosuggest-completed one.
    let cmdBuf = ''
    const readPromptLine = (): string => {
      try {
        const b = term.buffer.active
        const text = b.getLine(b.baseY + b.cursorY)?.translateToString(true) ?? ''
        const ps = text.match(/^PS .+?>\s(.*)$/) // PowerShell prompt injection
        if (ps) return ps[1]
        const generic = text.match(/^.*?[$#>]\s(.+)$/) // bash/zsh/other prompts
        return generic ? generic[1] : ''
      } catch {
        return ''
      }
    }
    const onUserInput = (d: string) => {
      idleChime.onInput() // operator engaged — don't read prompt-composing as "finished"
      if (d.charCodeAt(0) === 0x1b) {
        cmdBuf = '' // an escape sequence (arrow/history) — stop tracking this line
        return
      }
      for (const ch of d) {
        if (ch === '\r' || ch === '\n') {
          if (isAgentCommand(cmdBuf) || isAgentCommand(readPromptLine())) idleChime.setArmed(true)
          cmdBuf = ''
        } else if (ch === '\x7f' || ch === '\b') cmdBuf = cmdBuf.slice(0, -1)
        else if (ch === '\x03' || ch === '\x15') cmdBuf = ''
        else if (ch >= ' ') cmdBuf += ch
      }
    }

    // Visual bell: flash the pane when the shell emits BEL (\x07). xterm 5's
    // typings don't expose onBell, so we sniff the output stream instead.
    const flashBell = () => {
      host.classList.add('bell-flash')
      window.setTimeout(() => host.classList.remove('bell-flash'), 160)
    }
    const writeData = (d: string) => {
      // Bell scan only runs when the user opted in. Skipping `indexOf('\x07')`
      // when the cached setting is off skips a full-chunk scan on every PTY
      // data chunk — the data path runs in tight loops during fast command
      // output, so this micro-opt is worth it.
      if (bellOnRef.current && d.indexOf('\x07') !== -1) flashBell()
      idleChime.feed(d)
      term.write(d)
    }

    fitNow(fit, host)

    // Track working directory via OSC 7 (shell integration) → session store.
    term.parser.registerOscHandler(7, (payload) => {
      const path = parseOsc7(payload)
      if (path) useSessions.getState().setCwd(session.id, path)
      return true
    })

    // OSC 133 ;A (a fresh shell prompt) means an inline agent has exited — stop
    // watching this terminal. Registered after autosuggest's 133 handler and
    // returns false so that one still runs (xterm calls them last-registered-first).
    term.parser.registerOscHandler(133, (data) => {
      if (data[0] === 'A') idleChime.setArmed(false)
      return false
    })

    let disposed = false
    const cleanups: Array<() => void> = [idleChime.dispose]

    const wireResize = (resize: (cols: number, rows: number) => void) => {
      resizeRef.current = resize
      let lastCols = term.cols
      let lastRows = term.rows
      // Notify the backend only when the *character* grid actually changed.
      const notify = () => {
        if (term.cols === lastCols && term.rows === lastRows) return
        lastCols = term.cols
        lastRows = term.rows
        resize(term.cols, term.rows)
      }
      // Fit xterm visually on each animation frame so a drag reflows smoothly,
      // but DON'T push a PTY resize per frame: a splitter/window drag steps
      // through many column counts, and PowerShell/PSReadLine repaints its
      // prompt on every backend resize (the stack of blank prompts after a
      // drag). Instead debounce the backend resize to the trailing edge of the
      // drag, so PSReadLine repaints once when the size settles.
      let raf = 0
      let settle = 0
      const schedule = () => {
        // Pre-layout hosts report 0×0 — fitting then computes 0 cols and corrupts
        // the buffer. (Hidden slots are hidden with `visibility`, not `display`,
        // exactly so they keep real dimensions and stay fitted while unseen.)
        if (host.clientWidth < 20 || host.clientHeight < 20) return
        if (!raf) {
          raf = requestAnimationFrame(() => {
            raf = 0
            fitNow(fit, host)
          })
        }
        if (settle) clearTimeout(settle)
        settle = window.setTimeout(notify, 120)
      }
      const ro = new ResizeObserver(schedule)
      ro.observe(host)
      window.addEventListener('resize', schedule)
      cleanups.push(() => {
        if (raf) cancelAnimationFrame(raf)
        if (settle) clearTimeout(settle)
        ro.disconnect()
        window.removeEventListener('resize', schedule)
      })
      // Settle the initial layout across a few frames, then sync the backend once.
      fitSoon(fit, host, notify)
    }

    if (session.kind === 'local') {
      ;(async () => {
        const { id } = await window.devterm.pty.create({
          cols: term.cols,
          rows: term.rows,
          cwd: session.startCwd,
          // Honor the user's default-shell setting on each new local terminal.
          // The main process resolves the pref to an absolute path (or to its
          // own default when the chosen shell isn't installed). Reading via
          // getState() — the terminal mount path doesn't need to re-render on
          // shell-pref changes; existing terminals keep their original pty.
          shellPref: useSettings.getState().defaultShell
        })
        if (disposed) return window.devterm.pty.kill(id)
        cleanups.push(window.devterm.pty.onData(id, writeData))
        // Startup-failure diagnostic: if the main process saw the shell exit
        // before emitting any data (Windows PowerShell 5.1's 0x8009001d is the
        // canonical case), capture the shell path here so the upcoming
        // onExit can render a targeted fix instead of a generic notice. The
        // diagnostic fires once and races the exit event; whichever wins last
        // drives the message.
        let startupShell: string | undefined
        cleanups.push(
          window.devterm.pty.onStartupFailure(id, (info) => {
            startupShell = info.shell
          })
        )
        cleanups.push(
          window.devterm.pty.onExit(id, ({ exitCode }) => {
            // ConPTY can tear down without reporting a code (e.g. the console
            // host died under a misbehaving TUI) — don't print "code undefined".
            const code = typeof exitCode === 'number' ? ` with code ${exitCode}` : ''
            if (startupShell) {
              // Render a targeted diagnostic instead of the generic exit
              // notice. The banner is plain ASCII + ANSI colour so it lands
              // intact on whatever shell the user opens next (the pane is
              // already terminal-shaped — a clipboard-friendly fix is more
              // useful than a styled component here).
              term.write(`${EXIT_RESET}\r\n`)
              term.write(`\x1b[31m[Shell failed to start]\x1b[0m\r\n`)
              term.write(`\x1b[90m  ${startupShell}\x1b[0m\r\n`)
              term.write(
                `\x1b[90m  Exit code: ${typeof exitCode === 'number' ? exitCode : 'unknown'}\x1b[0m\r\n`
              )
              term.write(
                isWindowsPowerShellPath(startupShell)
                  ? powershellFailureHelp()
                  : genericFailureHelp(startupShell)
              )
            } else {
              term.write(`${EXIT_RESET}\r\n\x1b[90m[process exited${code}]\x1b[0m\r\n`)
            }
          })
        )
        sendInput = (d) => window.devterm.pty.input(id, d)
        term.onData((d) => {
          onUserInput(d)
          window.devterm.pty.input(id, d)
        })
        wireResize((c, r) => window.devterm.pty.resize(id, c, r))
        cleanups.push(() => window.devterm.pty.kill(id))
      })()
    } else {
      const sid = session.id
      // Subscribe before opening the shell so the login banner isn't missed.
      cleanups.push(window.devterm.ssh.onData(sid, writeData))
      cleanups.push(
        window.devterm.ssh.onExit(sid, () =>
          term.write(`${EXIT_RESET}\r\n\x1b[90m[connection closed]\x1b[0m\r\n`)
        )
      )
      window.devterm.ssh
        .openShell(sid, term.cols, term.rows)
        .then(() => {
          // Best-effort: restore the working directory when launched from a
          // saved workspace. Works for POSIX shells and PowerShell alike.
          if (session.startCwd) {
            const p = session.startCwd.replace(/"/g, '\\"')
            window.devterm.ssh.input(sid, `cd "${p}"\r`)
          }
        })
        .catch((e) => {
          term.write(`\r\n\x1b[31m[failed to open shell: ${String(e)}]\x1b[0m\r\n`)
        })
      sendInput = (d) => window.devterm.ssh.input(sid, d)
      term.onData((d) => {
        onUserInput(d)
        window.devterm.ssh.input(sid, d)
      })
      wireResize((c, r) => window.devterm.ssh.resize(sid, c, r))
    }

    return () => {
      disposed = true
      suggest.dispose()
      suggestRef.current = null
      cleanups.forEach((fn) => fn())
      unregisterTerminal(session.id)
      resizeRef.current = null
      fitRef.current = null
      searchRef.current = null
      disposeClipboard()
      disposeRenderer()
      term.dispose()
      termRef.current = null
    }
    // startCwd is a one-time initial value consumed at mount; it never changes
    // for a live session, so it intentionally stays out of the dependency list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id, session.kind])

  // Live-apply theme + background changes from Settings without recreating the
  // terminal. A theme swap repaints the whole ANSI palette; a background change
  // just re-tints the host and (if an image toggles) the terminal layer.
  const terminalBg = useSettings((s) => s.terminalBg)
  const themeId = useSettings((s) => s.themeId)
  useEffect(() => {
    const term = termRef.current
    const host = hostRef.current
    if (!term || !host) return
    const theme = getTheme(themeId)
    term.options.theme = xtermTheme(theme, terminalBg)
    applyHostBg(host, terminalBg, theme)
  }, [terminalBg, themeId])

  // Live-apply appearance/behavior prefs (font, cursor, scrollback, …). A font
  // change alters the character grid, so re-fit and push one backend resize.
  const prefs = useSettings((s) => s.prefs)
  useEffect(() => {
    const term = termRef.current
    const host = hostRef.current
    if (!term || !host) return
    term.options.fontSize = prefs.fontSize
    term.options.fontFamily = prefs.fontFamily
    term.options.lineHeight = prefs.lineHeight
    term.options.cursorStyle = prefs.cursorStyle
    term.options.cursorBlink = prefs.cursorBlink
    term.options.scrollback = prefs.scrollback
    // scrollSensitivity is an xterm init-only option (constructor only), so it
    // applies to newly opened terminals rather than updating live here.
    if (fitRef.current && fitNow(fitRef.current, host)) {
      resizeRef.current?.(term.cols, term.rows)
    }
    // Refresh the per-terminal bell cache so the writeData hot path can skip
    // its indexOf scan when the user has bells disabled.
    bellOnRef.current = prefs.bell === 'visual'
  }, [prefs])

  const reconnect = async () => {
    if (!session.connectionId) return
    const conns = await window.devterm.connections.list()
    const c = conns.find((x) => x.id === session.connectionId)
    if (!c) return
    const { id: _id, name: _name, ...profile } = c
    await useSessions
      .getState()
      .connectSsh(profile, { connectionId: c.id, startCwd: session.cwd, groupId: session.groupId })
    useSessions.getState().close(session.id)
  }

  return (
    <div className="terminal-wrap">
      <div className="terminal-host" ref={hostRef} />
      <Autosuggest
        view={suggestView}
        onAccept={(i) => suggestRef.current?.accept(i)}
        onHover={(i) => suggestRef.current?.hover(i)}
      />
      {findOpen && (
        <SearchBar
          onSearch={(query, dir) => {
            const s = searchRef.current
            if (!s || !query) return
            if (dir < 0) s.findPrevious(query)
            else s.findNext(query)
          }}
          onClose={() => {
            setFindOpen(false)
            termRef.current?.focus()
          }}
        />
      )}
      {session.closed && session.kind === 'remote' && session.connectionId && (
        <div className="term-reconnect">
          <button onClick={reconnect}>⟳ Reconnect</button>
        </div>
      )}
    </div>
  )
}

// Memoized: the tiling layout re-renders on every drag/resize tick, but a live
// terminal only depends on its (stable) session — never re-run the xterm body
// for an unrelated layout change.
export default memo(TerminalView)
