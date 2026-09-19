import { ipcMain } from 'electron'
import { IPC } from '@shared/types'
import { globalOutputRings } from '../terminal/output-ring'

/**
 * Renderer xterm lifecycle control. This only gates the renderer stream and
 * returns retained bytes; it never owns or stops a PTY/SSH process.
 */
export function registerTerminalIpc(): void {
  ipcMain.handle(IPC.terminalSetHibernated, (_event, sessionId: string, hibernated: boolean) => {
    if (typeof sessionId !== 'string' || !sessionId) return
    globalOutputRings.setForwardingForSession(sessionId, hibernated !== true)
  })

  ipcMain.handle(IPC.terminalReplay, (_event, sessionId: string) => {
    if (typeof sessionId !== 'string' || !sessionId) return ''
    return globalOutputRings.replayAndResume(sessionId)
  })
}
