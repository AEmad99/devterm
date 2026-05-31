import { clipboard, ipcMain } from 'electron'
import { IPC } from '@shared/types'

/**
 * System clipboard bridge. The renderer is sandboxed (`sandbox: true`,
 * `contextIsolation: true`) and has no reliable access to the web Clipboard API,
 * so terminal copy/paste routes through Electron's `clipboard` module here.
 */
export function registerClipboardIpc(): void {
  ipcMain.handle(IPC.clipboardWrite, (_e, text: string): void => {
    clipboard.writeText(typeof text === 'string' ? text : String(text))
  })
  ipcMain.handle(IPC.clipboardRead, (): string => clipboard.readText())
}
