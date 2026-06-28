import { clipboard, ipcMain } from 'electron'
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs'
import { randomBytes } from 'crypto'
import { tmpdir } from 'os'
import { join } from 'path'
import { IPC } from '@shared/types'

/**
 * System clipboard bridge. The renderer is sandboxed (`sandbox: true`,
 * `contextIsolation: true`) and has no reliable access to the web Clipboard API,
 * so terminal copy/paste routes through Electron's `clipboard` module here.
 */

// Pasted images land in a dedicated temp subdir so we can prune them without
// touching anything else in %TEMP%.
const CLIP_DIR = join(tmpdir(), 'devterm-clip')
const MAX_AGE_MS = 24 * 60 * 60 * 1000 // drop paste images older than a day

/** Best-effort prune so a long-running session doesn't accumulate paste PNGs. */
function pruneOldClips(): void {
  let names: string[]
  try {
    names = readdirSync(CLIP_DIR)
  } catch {
    return // dir not created yet
  }
  const now = Date.now()
  for (const name of names) {
    const f = join(CLIP_DIR, name)
    try {
      if (now - statSync(f).mtimeMs > MAX_AGE_MS) rmSync(f, { force: true })
    } catch {
      /* ignore a file we can't stat/remove */
    }
  }
}

export function registerClipboardIpc(): void {
  ipcMain.handle(IPC.clipboardWrite, (_e, text: string): void => {
    clipboard.writeText(typeof text === 'string' ? text : String(text))
  })
  ipcMain.handle(IPC.clipboardRead, (): string => clipboard.readText())

  // Save a clipboard image (e.g. a screenshot) to a temp PNG and return its
  // absolute path, or null when the clipboard holds no image. The renderer
  // pastes the returned path into the terminal so a coding agent (claude /
  // opencode / pi) running there can attach it — xterm cannot forward binary
  // image data through the PTY, and these CLIs accept images referenced by path.
  ipcMain.handle(IPC.clipboardSaveImage, (): string | null => {
    const img = clipboard.readImage()
    if (img.isEmpty()) return null
    const png = img.toPNG()
    if (!png || png.length === 0) return null
    try {
      mkdirSync(CLIP_DIR, { recursive: true })
      pruneOldClips()
      const file = join(CLIP_DIR, `paste-${Date.now()}-${randomBytes(3).toString('hex')}.png`)
      writeFileSync(file, png)
      return file
    } catch {
      return null
    }
  })
}
