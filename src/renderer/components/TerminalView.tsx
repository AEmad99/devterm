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
import { fitNow, fitSoon } from '../lib/fit'
import { attachRenderer, attachClipboard } from '../lib/renderer'
import { matchHotkey } from '../lib/hotkeys'
import { registerTerminal, unregisterTerminal } from '../lib/terms'
import SearchBar from './SearchBar'
import Autosuggest from './Autosuggest'
import { attachAutosuggest, type AutosuggestController, type SuggestView } from '../lib/autosuggest'

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
    let sendInput: (data: string) => void = () => {}
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
      if (e.ctrlKey && e.shiftKey && !e.altKey) {
        const k = e.key.toLowerCase()
        // preventDefault is load-bearing: returning false only stops xterm's own
        // handling, not the browser default. Chromium's default for Ctrl+Shift+V
        // is "paste as plain text", which fires a second `paste` event into
        // xterm's textarea — the clipboard text was pasted twice (or more with
        // key auto-repeat, hence the e.repeat guard).
        if (k === 'c') {
          e.preventDefault()
          if (term.hasSelection()) window.devterm.clipboard.writeText(term.getSelection())
          return false
        }
        if (k === 'v') {
          e.preventDefault()
          if (!e.repeat) void window.devterm.clipboard.readText().then((t) => t && term.paste(t))
          return false
        }
      }
      const id = matchHotkey(e)
      if (id === 'find') {
        setFindOpen(true)
        return false
      }
      return id === null
    })

    // Visual bell: flash the pane when the shell emits BEL (\x07). xterm 5's
    // typings don't expose onBell, so we sniff the output stream instead.
    const flashBell = () => {
      host.classList.add('bell-flash')
      window.setTimeout(() => host.classList.remove('bell-flash'), 160)
    }
    const writeData = (d: string) => {
      if (d.indexOf('\x07') !== -1 && useSettings.getState().prefs.bell === 'visual') flashBell()
      term.write(d)
    }

    fitNow(fit, host)

    // Track working directory via OSC 7 (shell integration) → session store.
    term.parser.registerOscHandler(7, (payload) => {
      const path = parseOsc7(payload)
      if (path) useSessions.getState().setCwd(session.id, path)
      return true
    })

    let disposed = false
    const cleanups: Array<() => void> = []

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
          cwd: session.startCwd
        })
        if (disposed) return window.devterm.pty.kill(id)
        cleanups.push(window.devterm.pty.onData(id, writeData))
        cleanups.push(
          window.devterm.pty.onExit(id, ({ exitCode }) =>
            term.write(`\r\n\x1b[90m[process exited with code ${exitCode}]\x1b[0m\r\n`)
          )
        )
        sendInput = (d) => window.devterm.pty.input(id, d)
        term.onData((d) => window.devterm.pty.input(id, d))
        wireResize((c, r) => window.devterm.pty.resize(id, c, r))
        cleanups.push(() => window.devterm.pty.kill(id))
      })()
    } else {
      const sid = session.id
      // Subscribe before opening the shell so the login banner isn't missed.
      cleanups.push(window.devterm.ssh.onData(sid, writeData))
      cleanups.push(
        window.devterm.ssh.onExit(sid, () =>
          term.write('\r\n\x1b[90m[connection closed]\x1b[0m\r\n')
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
      term.onData((d) => window.devterm.ssh.input(sid, d))
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
