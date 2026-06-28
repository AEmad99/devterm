import type { Terminal } from '@xterm/xterm'
import { CanvasAddon } from '@xterm/addon-canvas'
import { useSettings } from '../store/settings'

/**
 * Attach the **canvas** renderer to a terminal.
 *
 * We deliberately use canvas instead of the WebGL addon. The tiling layout keeps
 * every terminal in every group mounted simultaneously (so PTYs/SSH shells stay
 * alive across view/group switches), and each WebGL terminal holds its own GPU
 * context. Chromium hard-caps live WebGL contexts (~16) and silently evicts the
 * oldest once exceeded — which made panes blank out or glitch ("bugs out") once
 * enough terminals/workspaces were open, and degraded survivors onto the slow DOM
 * renderer. The canvas renderer has no per-context cap, is plenty fast for a
 * terminal grid, and scales cleanly with the mount-everything design. Falls back
 * to xterm's built-in DOM renderer if a canvas context can't be created.
 */
export function attachRenderer(term: Terminal): () => void {
  let canvas: CanvasAddon | undefined
  try {
    canvas = new CanvasAddon()
    term.loadAddon(canvas)
  } catch {
    /* xterm keeps its DOM renderer */
  }
  return () => {
    canvas?.dispose()
  }
}

/**
 * Wire mouse + selection clipboard behavior into a terminal. The app has no
 * application menu (so no native edit accelerators), and the renderer is
 * sandboxed — clipboard access goes through the `window.devterm.clipboard` bridge.
 *
 * - **Copy-on-select** (opt-in): mirror the selection to the clipboard as it's made.
 * - **Paste**: a single capture-phase `paste` listener owns every keyboard/native
 *   paste (Ctrl+V, Ctrl+Shift+V, middle-click) so it happens exactly once — see
 *   the comment on the listener for why xterm's own handler double-fires.
 * - **Right-click**: pastes when "right-click paste" is on; otherwise the classic
 *   gesture — copy the selection if there is one, else paste.
 *
 * The Ctrl+Shift+C copy binding lives in TerminalView's single custom key handler
 * (xterm only allows one); paste is owned here. Returns a disposer.
 */
export function attachClipboard(term: Terminal, host: HTMLElement): () => void {
  const copySelection = () => {
    if (term.hasSelection()) window.devterm.clipboard.writeText(term.getSelection())
  }

  // Collapse a duplicate paste that lands within a couple of frames (some
  // platforms fire two paste events for one Ctrl+Shift+V, "paste & match style").
  let lastPasteText = ''
  let lastPasteAt = 0
  const pasteText = (text: string) => {
    const now = Date.now()
    if (text === lastPasteText && now - lastPasteAt < 80) return
    lastPasteText = text
    lastPasteAt = now
    term.paste(text)
  }

  // Paste whatever the clipboard holds. Text wins; when there's no text the
  // clipboard may hold an image (e.g. a screenshot) — save it to a temp file and
  // paste the *path* so a coding agent running in the shell (claude / opencode /
  // pi) can attach it. Falls back to a bridge text read (covers middle-click on
  // platforms that don't populate the paste event's clipboardData).
  const pasteFromClipboard = async () => {
    try {
      const imgPath = await window.devterm.clipboard.saveImage()
      if (imgPath) {
        pasteText(imgPath)
        return
      }
    } catch {
      /* fall through to text */
    }
    const t = await window.devterm.clipboard.readText()
    if (t) pasteText(t)
  }

  const selDisposable = term.onSelectionChange(() => {
    if (useSettings.getState().prefs.copyOnSelect) copySelection()
  })

  // Single authoritative path for keyboard/native paste (Ctrl+V, Ctrl+Shift+V,
  // middle-click). xterm binds its OWN `paste` handler to both its textarea and
  // its root element, and that handler calls stopPropagation but NOT
  // preventDefault — so after it reads the clipboard and emits the text, the
  // browser STILL performs the default paste, inserting the same text into
  // xterm's hidden helper textarea, which xterm's input handler can then re-emit.
  // That race is the intermittent "pasted twice", and on a long line it reads as
  // the command "streaming" in. We catch the paste in the CAPTURE phase (before
  // xterm's listeners), stop it reaching them (stopImmediatePropagation) and stop
  // the browser's default insert (preventDefault), then paste exactly once.
  const onPaste = (e: ClipboardEvent) => {
    e.preventDefault()
    e.stopImmediatePropagation()
    const text = e.clipboardData?.getData('text/plain') ?? ''
    if (text) {
      pasteText(text)
      return
    }
    // No inline text — the clipboard may hold an image, or this is a platform
    // that doesn't populate clipboardData on paste. Resolve via the bridge
    // (image first, then text).
    void pasteFromClipboard()
  }
  host.addEventListener('paste', onPaste, true) // capture: beat xterm's handlers

  const onContextMenu = (e: MouseEvent) => {
    e.preventDefault()
    if (useSettings.getState().prefs.rightClickPaste) {
      void pasteFromClipboard()
    } else if (term.hasSelection()) {
      copySelection()
      term.clearSelection()
    } else {
      void pasteFromClipboard()
    }
  }
  host.addEventListener('contextmenu', onContextMenu)
  return () => {
    selDisposable.dispose()
    host.removeEventListener('paste', onPaste, true)
    host.removeEventListener('contextmenu', onContextMenu)
  }
}
