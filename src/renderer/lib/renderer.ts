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
 * - **Right-click**: pastes when "right-click paste" is on; otherwise the classic
 *   gesture — copy the selection if there is one, else paste.
 *
 * The Ctrl+Shift+C / Ctrl+Shift+V key bindings live in TerminalView's single
 * custom key handler (xterm only allows one). Returns a disposer.
 */
export function attachClipboard(term: Terminal, host: HTMLElement): () => void {
  const copySelection = () => {
    if (term.hasSelection()) window.devterm.clipboard.writeText(term.getSelection())
  }
  const paste = () => window.devterm.clipboard.readText().then((t) => t && term.paste(t))

  const selDisposable = term.onSelectionChange(() => {
    if (useSettings.getState().prefs.copyOnSelect) copySelection()
  })

  const onContextMenu = (e: MouseEvent) => {
    e.preventDefault()
    if (useSettings.getState().prefs.rightClickPaste) {
      void paste()
    } else if (term.hasSelection()) {
      copySelection()
      term.clearSelection()
    } else {
      void paste()
    }
  }
  host.addEventListener('contextmenu', onContextMenu)
  return () => {
    selDisposable.dispose()
    host.removeEventListener('contextmenu', onContextMenu)
  }
}
