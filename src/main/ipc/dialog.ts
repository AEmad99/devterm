import { dialog, ipcMain, BrowserWindow } from 'electron'
import { promises as fs } from 'fs'
import { extname } from 'path'
import { IPC } from '@shared/types'

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml'
}

// Cap embedded images so we don't bloat the renderer's localStorage / data URL.
const MAX_IMAGE_BYTES = 8 * 1024 * 1024

/**
 * Native image picker for the terminal-background setting. Reads the chosen file
 * and returns it as a `data:` URL so the sandboxed renderer can use it directly
 * (no file:// access, no custom protocol needed).
 */
export function registerDialogIpc(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle(IPC.dialogChooseImage, async (): Promise<string | null> => {
    const win = getWindow()
    const opts = {
      title: 'Choose a terminal background image',
      properties: ['openFile' as const],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'] }]
    }
    const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (result.canceled || result.filePaths.length === 0) return null

    const file = result.filePaths[0]
    const data = await fs.readFile(file)
    if (data.byteLength > MAX_IMAGE_BYTES) {
      throw new Error(
        `Image is too large (${Math.round(data.byteLength / 1024 / 1024)} MB). Max is 8 MB.`
      )
    }
    const mime = MIME[extname(file).toLowerCase()] || 'image/png'
    return `data:${mime};base64,${data.toString('base64')}`
  })
}
