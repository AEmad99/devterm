// Foundation (cluster gate) — IPC wiring for the new namespaces.
//
// One file owns the registration so `src/main/index.ts` stays focused on
// window/menu/lifecycle. The new channels here are:
//
//   - bridge-activity:{list,clear,event:<sessionId>}
//       list/clear are invoke; event is a per-session push the renderer
//       subscribes to via `bridgeActivity.on()`.
//   - settings-io:{export,import,sync}
//       Export/import pop a native file dialog. The renderer's localStorage
//       is the canonical live store; `sync` lets it push its full snapshot
//       to `userData/settings.json` so the export bundle is up to date. On
//       import, `settingsImported` fires with the merged-with-defaults
//       snapshot for the renderer to apply.
//   - approval-rules (action-style single channel)
//       Payload: { op: 'list'|'add'|'remove'|'match', ... }. We dispatch on
//       `op` so adding a new verb later doesn't multiply channel constants.
//   - port-forward:{list,add,remove}
//       All real for local `-L` forwards (delegated to
//       `SSHManager.forwardManager`). Dynamic `-D` SOCKS throws inside the
//       manager.

import { BrowserWindow, dialog, ipcMain } from 'electron'
import { IPC } from '@shared/types'
import type { SSHManager } from './ssh/manager'
import * as bridgeActivity from './bridge-activity'
import * as approvalRules from './approval-rules'
import * as knownHosts from './ssh/knownHosts'
import * as settingsIo from './settings-io'
import * as quickConnect from './quick-connect'
import { setPersistEnabled } from './search'

function pushBridgeActivity(
  getWindow: () => BrowserWindow | null,
  sessionId: string,
  entry: import('@shared/types').BridgeActivityEntry
): void {
  const win = getWindow()
  win?.webContents.send(`${IPC.bridgeActivityEvent}:${sessionId}`, entry)
}

export function registerFoundationIpc(
  getWindow: () => BrowserWindow | null,
  sshManager: SSHManager
): void {
  // -------------------------------------------------------------------------
  // bridge-activity
  // -------------------------------------------------------------------------
  ipcMain.handle(
    IPC.bridgeActivityList,
    async (_e, sessionId: string, opts?: { sinceMs?: number; limit?: number }) => {
      if (typeof sessionId !== 'string') return []
      return bridgeActivity.listAsync(sessionId, opts)
    }
  )

  ipcMain.handle(IPC.bridgeActivityClear, async (_e, sessionId: string) => {
    if (typeof sessionId !== 'string') return
    bridgeActivity.clear(sessionId)
  })

  ipcMain.handle(IPC.bridgeActivityExport, async (_e, sessionId: string, targetPath?: string) => {
    if (typeof sessionId !== 'string') return null
    let path = targetPath
    if (!path) {
      const win = getWindow()
      const opts = {
        title: 'Export bridge activity log',
        defaultPath: `devterm-bridge-${sessionId.slice(0, 8)}-${new Date()
          .toISOString()
          .slice(0, 10)}.jsonl`,
        filters: [{ name: 'JSON Lines', extensions: ['jsonl'] }]
      }
      const result = win
        ? await dialog.showSaveDialog(win, opts)
        : await dialog.showSaveDialog(opts)
      if (result.canceled || !result.filePath) return null
      path = result.filePath
    }
    return bridgeActivity.exportSession(sessionId, path)
  })

  // The data layer doesn't know about BrowserWindow — expose a tiny bus so
  // other modules (the agent bridge, the policy enforcer) can record events
  // without importing Electron. They call `recordAndPush` and we both update
  // the ring and push to the renderer.
  bridgeActivityBus = (entry) => {
    const stored = bridgeActivity.record(entry)
    pushBridgeActivity(getWindow, stored.sessionId, stored)
    return stored
  }

  // -------------------------------------------------------------------------
  // settings-io
  // -------------------------------------------------------------------------
  ipcMain.handle(IPC.settingsIoExport, async () => {
    await settingsIo.exportToPath(getWindow)
  })

  ipcMain.handle(IPC.settingsIoImport, async () => {
    const result = await settingsIo.importFromPath(getWindow)
    if (result.ok) {
      const win = getWindow()
      if (win && !win.isDestroyed())
        win.webContents.send(IPC.settingsImported, result.settings ?? null)
    }
    return result
  })

  /**
   * Renderer → main: push the live `AppSettings` snapshot so
   * `userData/settings.json` stays in sync with the renderer's localStorage
   * store. Tolerant of any (possibly partial) snapshot.
   */
  ipcMain.on(IPC.settingsSync, (_e, snapshot: import('@shared/types').SettingsSnapshot) => {
    if (!snapshot || typeof snapshot !== 'object') return
    // Forward the persist-search toggle to the search module so a setting
    // flip takes effect without a restart.
    setPersistEnabled(snapshot.searchPersist === true)
    settingsIo.scheduleSnapshot(snapshot)
  })

  // -------------------------------------------------------------------------
  // approval-rules (action-style)
  // -------------------------------------------------------------------------
  ipcMain.handle(
    IPC.approvalRules,
    async (
      _e,
      payload:
        | { op: 'list'; sessionId?: string }
        | { op: 'add'; rule: import('@shared/types').ApprovalRule }
        | { op: 'remove'; id: string }
        | { op: 'match'; sessionId: string; command: string }
    ) => {
      switch (payload.op) {
        case 'list':
          return approvalRules.list(payload.sessionId)
        case 'add': {
          await approvalRules.add(payload.rule)
          return approvalRules.list(payload.rule.sessionId)
        }
        case 'remove': {
          await approvalRules.remove(payload.id)
          return approvalRules.list()
        }
        case 'match':
          return (await approvalRules.match(payload.sessionId, payload.command)) ?? null
      }
    }
  )

  // -------------------------------------------------------------------------
  // known-hosts (TOFU store)
  // -------------------------------------------------------------------------
  ipcMain.handle(IPC.knownHostsList, async () => knownHosts.list())
  ipcMain.handle(IPC.knownHostsRemove, async (_e, hostId: string) => {
    if (typeof hostId !== 'string') return
    await knownHosts.remove(hostId)
  })

  // -------------------------------------------------------------------------
  // quick-connect (recent host:port:user triples)
  // -------------------------------------------------------------------------
  ipcMain.handle(IPC.quickConnectList, async () => quickConnect.list())
  ipcMain.handle(
    IPC.quickConnectRecord,
    async (_e, host: string, port: number, username: string) => {
      if (typeof host !== 'string' || typeof port !== 'number' || typeof username !== 'string') {
        return
      }
      await quickConnect.record(host, port, username)
    }
  )
  // -------------------------------------------------------------------------
  // port-forward
  // -------------------------------------------------------------------------
  ipcMain.handle(IPC.portForwardList, async (_e, sessionId?: string) => {
    return sshManager.forwardManager.list(sessionId)
  })

  ipcMain.handle(
    IPC.portForwardAdd,
    async (_e, req: Omit<import('@shared/types').PortForward, 'id' | 'createdAt' | 'bytes'>) => {
      return sshManager.forwardManager.add(
        req.sessionId,
        req.kind,
        req.localPort,
        req.remoteHost,
        req.remotePort
      )
    }
  )

  ipcMain.handle(IPC.portForwardRemove, async (_e, id: string) => {
    await sshManager.forwardManager.remove(id)
  })
}

// Module-local bus the agent bridge / other modules use to record a bridge
// activity entry AND push it to the renderer. Default is a no-op so that
// importing this module from a test (without a registered ipc layer) is safe.
type BridgeActivityRecorder = (
  entry: Omit<import('@shared/types').BridgeActivityEntry, 'id' | 'ts'>
) => import('@shared/types').BridgeActivityEntry

let bridgeActivityBus: BridgeActivityRecorder = (entry) => bridgeActivity.record(entry)

/** Public entry point for other modules to record + push a bridge event. */
export function recordBridgeActivity(
  entry: Omit<import('@shared/types').BridgeActivityEntry, 'id' | 'ts'>
): import('@shared/types').BridgeActivityEntry {
  return bridgeActivityBus(entry)
}
