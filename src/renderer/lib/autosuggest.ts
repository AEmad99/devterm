// History-driven inline autocomplete for a terminal pane.
//
// A terminal's *shell* owns line editing, so xterm doesn't natively know what
// you've typed. We solve that with OSC 133 "semantic prompt" markers injected
// into the prompt (see pty/manager.ts and ssh/manager.ts): the ;B marker fires
// exactly where command input begins, so we record that cursor position as an
// anchor and read the current command straight from xterm's buffer between the
// anchor and the caret. We never write into the terminal (no fighting the
// shell's redraw) — suggestions render in a DOM popup, and accepting just sends
// the missing keystrokes to the shell as if you'd typed them.

import type { Terminal } from '@xterm/xterm'
import type { CommandStat, HistoryQuery } from '@shared/types'

/** Popup state handed to the React layer; null hides the popup. */
export interface SuggestView {
  /** Candidate full commands, best first. */
  items: string[]
  /** Highlighted item (keyboard accepts this one). */
  index: number
  /** What the user has typed so far (the shared prefix of every item). */
  prefix: string
  /** Pixel offset within the terminal host. */
  left: number
  top: number
  /** Render above the caret instead of below (near the bottom of the pane). */
  above: boolean
}

/**
 * History commands that continue `prefix` (case-insensitive), recency first then
 * by frequency, deduped. Only commands that add something past the prefix count.
 */
export function suggestionsFor(
  prefix: string,
  recent: string[],
  frequent: CommandStat[],
  limit = 6
): string[] {
  if (!prefix.trim()) return []
  const lp = prefix.toLowerCase()
  const out: string[] = []
  const seen = new Set<string>()
  const consider = (cmd: string) => {
    if (out.length >= limit || !cmd || seen.has(cmd)) return
    if (cmd.length <= prefix.length) return // must complete to something longer
    if (!cmd.toLowerCase().startsWith(lp)) return
    seen.add(cmd)
    out.push(cmd)
  }
  for (const c of recent) consider(c)
  for (const f of frequent) consider(f.command)
  return out
}

/** Keystrokes that turn the typed `prefix` into the full `command` at the caret. */
export function acceptKeys(prefix: string, command: string): string {
  // Fast path: the command literally continues what's on screen — just append.
  if (command.startsWith(prefix)) return command.slice(prefix.length)
  // Case-insensitive match: erase the typed prefix (DEL ×n) and type the command.
  return '\x7f'.repeat(prefix.length) + command
}

interface Anchor {
  /** Absolute buffer line (baseY + cursorY) where command input begins. */
  line: number
  /** Column where command input begins. */
  x: number
}

export interface AutosuggestController {
  /** Returns true if the popup consumed the key (caller should block the shell). */
  handleKey(e: KeyboardEvent): boolean
  /** Accept item `i` (sends the completing keystrokes to the shell). */
  accept(i: number): void
  /** Highlight item `i` (mouse hover). */
  hover(i: number): void
  hide(): void
  dispose(): void
}

const POPUP_WIDTH = 340

export function attachAutosuggest(
  term: Terminal,
  host: HTMLElement,
  opts: {
    query: HistoryQuery
    send: (data: string) => void
    onChange: (view: SuggestView | null) => void
  }
): AutosuggestController {
  let anchor: Anchor | null = null
  let recent: string[] = []
  let frequent: CommandStat[] = []
  let view: SuggestView | null = null
  let index = 0
  let lastFetch = 0
  let raf = 0
  let disposed = false
  const subs: Array<{ dispose: () => void }> = []

  const fetch = () => {
    lastFetch = Date.now()
    window.devterm.history
      .query(opts.query)
      .then((r) => {
        recent = r.recent
        frequent = r.frequent
      })
      .catch(() => {})
  }

  const hide = () => {
    if (view !== null) {
      view = null
      opts.onChange(null)
    }
  }

  // Pixel position of the caret within the host (cell-size approximation; the
  // popup only needs to land near the caret, not pixel-perfect).
  const caretPixel = (): { left: number; top: number; above: boolean } => {
    const screen = host.querySelector('.xterm-screen') as HTMLElement | null
    const cw = (screen?.clientWidth ?? host.clientWidth) / Math.max(1, term.cols)
    const ch = (screen?.clientHeight ?? host.clientHeight) / Math.max(1, term.rows)
    const b = term.buffer.active
    const above = b.cursorY > term.rows * 0.6
    const left = Math.max(4, Math.min(cw * b.cursorX, host.clientWidth - POPUP_WIDTH))
    const top = above ? ch * b.cursorY : ch * (b.cursorY + 1)
    return { left, top, above }
  }

  const show = (prefix: string, items: string[]) => {
    index = 0
    const pos = caretPixel()
    view = { items, index, prefix, left: pos.left, top: pos.top, above: pos.above }
    opts.onChange(view)
  }

  const reevaluate = () => {
    if (disposed) return
    if (!anchor || host.clientWidth < 40) return hide() // no prompt anchor / hidden pane
    const b = term.buffer.active
    const curLine = b.baseY + b.cursorY
    // v1 handles single-row input; a wrapped/multi-row command just won't suggest.
    if (curLine !== anchor.line) return hide()
    const line = b.getLine(curLine)
    if (!line) return hide()
    const prefix = line.translateToString(false, anchor.x, b.cursorX) // keep spaces
    if (!prefix.trim()) return hide()
    if (line.translateToString(true, b.cursorX).trim().length) return hide() // caret not at end
    const items = suggestionsFor(prefix, recent, frequent)
    if (!items.length) return hide()
    show(prefix, items)
  }

  const schedule = () => {
    if (raf) return
    raf = requestAnimationFrame(() => {
      raf = 0
      reevaluate()
    })
  }

  // OSC 133: ;A = prompt start (refresh history), ;B = input start (set anchor),
  // ;C/;D = command run/finished (drop the anchor and hide).
  subs.push(
    term.parser.registerOscHandler(133, (data) => {
      const k = data[0]
      if (k === 'B') {
        const b = term.buffer.active
        anchor = { line: b.baseY + b.cursorY, x: b.cursorX }
        schedule()
      } else if (k === 'A') {
        if (Date.now() - lastFetch > 4000) fetch()
      } else if (k === 'C' || k === 'D') {
        anchor = null
        hide()
      }
      return true
    })
  )
  subs.push(term.onData(() => schedule()))
  subs.push(term.onCursorMove(() => schedule()))
  subs.push(term.onScroll(() => hide()))

  fetch()

  const accept = (i: number) => {
    if (!view) return
    const cmd = view.items[i]
    if (!cmd) return
    opts.send(acceptKeys(view.prefix, cmd))
    hide()
  }

  const hover = (i: number) => {
    if (!view || i === index) return
    index = i
    view = { ...view, index }
    opts.onChange(view)
  }

  const handleKey = (e: KeyboardEvent): boolean => {
    if (!view) return false
    if (e.key === 'Escape') {
      hide()
      return true
    }
    if (e.key === 'ArrowRight' || (e.key === 'Tab' && !e.shiftKey)) {
      accept(index)
      return true
    }
    // Enter submits the typed line; just dismiss the popup and let it through.
    if (e.key === 'Enter') hide()
    return false
  }

  const dispose = () => {
    disposed = true
    if (raf) cancelAnimationFrame(raf)
    subs.forEach((s) => s.dispose())
    hide()
  }

  return { handleKey, accept, hover, hide, dispose }
}
