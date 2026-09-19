import { ipcMain, BrowserWindow } from 'electron'
import { IPC, type PtyCreateOptions } from '@shared/types'
import { PtyManager } from '../pty/manager'
import { makeCoalescer } from './coalesce'
import { globalSearchIndex } from '../search/index'
import { broadcast } from './broadcast'
import { globalOutputRings, outputStreamKey } from '../terminal/output-ring'

/**
 * Registers PTY IPC handlers. Data/exit events are pushed to the renderer on
 * per-pty channels (`pty:data:<id>`) so multiple panes don't cross-talk.
 * Events are broadcast to every window so a floating agent pane can attach
 * to the same PTY stream as a stashed main-window agent view.
 */
export function registerPtyIpc(_getWindow: () => BrowserWindow | null): PtyManager {
  const send = (channel: string, ...args: unknown[]) => broadcast(channel, ...args)

  // Map PTY id → renderer session id so the search index is keyed the same
  // way the renderer seeds/queries it (by session id, not raw PTY id).
  const searchKeys = new Map<string, string>()
  const searchKey = (id: string) => searchKeys.get(id) ?? id
  const dropSearchKey = (id: string) => {
    // Mirror the SSH path: a dead session must not keep surfacing stale hits.
    const sessionId = searchKeys.get(id)
    globalSearchIndex.clearSession(sessionId ?? id)
    if (sessionId) {
      globalOutputRings.unbindSession(sessionId, outputStreamKey('pty', id))
    }
    searchKeys.delete(id)
  }

  const sendData = makeCoalescer((id, data) => {
    const outputKey = outputStreamKey('pty', id)
    globalOutputRings.append(outputKey, data)
    // Feed live PTY output into global search index (MVP: split per line).
    // A push can throw on a closed session (the index drops it); we never
    // want a search-index glitch to break the live PTY data path.
    try {
      globalSearchIndex.pushLine(searchKey(id), data)
    } catch {
      /* search index miss — keep streaming */
    }
    const sessionId = searchKeys.get(id)
    if (globalOutputRings.isForwarding(outputKey)) {
      send(`${IPC.ptyData}:${id}`, data)
    } else if (sessionId) {
      send(`${IPC.terminalActivity}:${sessionId}`, {
        bytes: Buffer.byteLength(data, 'utf8')
      })
    }
  })
  const manager = new PtyManager({
    onData: (id, data, sessionId) => {
      // Set this before the coalesced sink runs so even the first shell banner
      // is indexed under the renderer session id rather than the private PTY id.
      if (sessionId) searchKeys.set(id, sessionId)
      sendData.push(id, data)
    },
    onExit: (id, exitCode, signal) => {
      // Flush any buffered output for this pty first so the exit event can't
      // overtake the process's final bytes still sitting in the coalescer.
      sendData.flush(id)
      globalOutputRings.remove(outputStreamKey('pty', id))
      dropSearchKey(id)
      send(`${IPC.ptyExit}:${id}`, { exitCode, signal })
    },
    onDispose: (id) => {
      // Agent shutdown calls PtyManager.kill() directly rather than going
      // through renderer IPC; release its ring and search key as well.
      sendData.flush(id)
      globalOutputRings.remove(outputStreamKey('pty', id))
      dropSearchKey(id)
    },
    onStartupFailure: (id, info) => {
      // Fired when a shell exits within the startup health window without
      // ever producing data — the Windows PowerShell 5.1 0x8009001d case is
      // the canonical example. Pushed to the renderer so its TerminalView can
      // render a targeted diagnostic instead of the generic exit banner.
      // Independent of the regular exit event; both fire.
      send(`${IPC.ptyStartupFailure}:${id}`, info)
    }
  })

  ipcMain.handle(IPC.ptyCreate, async (_e, opts: PtyCreateOptions) => {
    const created = await manager.create(opts)
    if (opts.sessionId) {
      searchKeys.set(created.id, opts.sessionId)
      globalOutputRings.bindSession(opts.sessionId, outputStreamKey('pty', created.id))
    }
    return created
  })
  ipcMain.on(IPC.ptyInput, (_e, id: string, data: string) => manager.input(id, data))
  ipcMain.on(IPC.ptyResize, (_e, id: string, cols: number, rows: number) =>
    manager.resize(id, cols, rows)
  )
  ipcMain.on(IPC.ptyKill, (_e, id: string) => {
    sendData.flush(id)
    manager.kill(id)
    // Kill may suppress the exit event on some platforms — clear eagerly.
    globalOutputRings.remove(outputStreamKey('pty', id))
    dropSearchKey(id)
  })

  return manager
}
