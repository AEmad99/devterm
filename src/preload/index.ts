import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC,
  type DevTermApi,
  type PtyCreateOptions,
  type PtyCreated,
  type SSHProfile,
  type SSHConnectResult,
  type SSHStatus,
  type ReconnectPolicy,
  type HostContext,
  type DirListing,
  type FileContent,
  type TransferStartOpts,
  type TransferProgress,
  type AgentOpenOpts,
  type AgentOpenResult,
  type AgentBridgeStatus,
  type ConfirmRequest,
  type SavedConnection,
  type Workspace,
  type Snippet,
  type HistoryQuery,
  type HistoryResult,
  type BridgeActivityEntry,
  type ApprovalRule,
  type PortForward,
  type GitStatus,
  type TransferItemV2,
  type TransferEvent,
  type TransferListResult,
  type BrowserDownloadItem
} from '@shared/types'

// Subscribe helper for per-id main->renderer channels.
function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: unknown, payload: T) => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

// Only a typed, minimal surface is exposed to the renderer (§7.1).
const api: DevTermApi = {
  pty: {
    create: (opts: PtyCreateOptions): Promise<PtyCreated> =>
      ipcRenderer.invoke(IPC.ptyCreate, opts),
    input: (id, data) => ipcRenderer.send(IPC.ptyInput, id, data),
    resize: (id, cols, rows) => ipcRenderer.send(IPC.ptyResize, id, cols, rows),
    kill: (id) => ipcRenderer.send(IPC.ptyKill, id),
    onData: (id, cb) => subscribe<string>(`${IPC.ptyData}:${id}`, cb),
    onExit: (id, cb) => subscribe<{ exitCode: number; signal?: number }>(`${IPC.ptyExit}:${id}`, cb)
  },
  ssh: {
    connect: (profile: SSHProfile): Promise<SSHConnectResult> =>
      ipcRenderer.invoke(IPC.sshConnect, profile),
    openShell: (id, cols, rows): Promise<void> =>
      ipcRenderer.invoke(IPC.sshOpenShell, id, cols, rows),
    input: (id, data) => ipcRenderer.send(IPC.sshInput, id, data),
    resize: (id, cols, rows) => ipcRenderer.send(IPC.sshResize, id, cols, rows),
    disconnect: (id) => ipcRenderer.send(IPC.sshDisconnect, id),
    cancelReconnect: (id: string) => ipcRenderer.send(IPC.sshCancelReconnect, id),
    getReconnectPolicy: (): Promise<ReconnectPolicy> => ipcRenderer.invoke(IPC.sshGetReconnectPolicy),
    setReconnectPolicy: (patch: Partial<ReconnectPolicy>): Promise<ReconnectPolicy> =>
      ipcRenderer.invoke(IPC.sshSetReconnectPolicy, patch),
    onData: (id, cb) => subscribe<string>(`${IPC.sshData}:${id}`, cb),
    onExit: (id, cb) => subscribe<void>(`${IPC.sshExit}:${id}`, () => cb()),
    onStatus: (id, cb) => subscribe<SSHStatus>(`${IPC.sshStatus}:${id}`, cb)
  },
  fs: {
    list: (path?: string): Promise<DirListing> => ipcRenderer.invoke(IPC.fsList, path),
    home: (): Promise<string> => ipcRenderer.invoke(IPC.fsHome),
    mkdir: (path: string): Promise<void> => ipcRenderer.invoke(IPC.fsMkdir, path),
    createFile: (path: string): Promise<void> => ipcRenderer.invoke(IPC.fsCreateFile, path),
    rename: (from: string, to: string): Promise<void> => ipcRenderer.invoke(IPC.fsRename, from, to),
    delete: (path: string): Promise<void> => ipcRenderer.invoke(IPC.fsDelete, path),
    readFile: (path: string): Promise<FileContent> => ipcRenderer.invoke(IPC.fsReadFile, path),
    writeFile: (path: string, content: string): Promise<{ mtimeMs: number; size: number }> =>
      ipcRenderer.invoke(IPC.fsWriteFile, path, content),
    watch: (path: string): Promise<string> => ipcRenderer.invoke(IPC.fsWatch, path),
    unwatch: (watchId: string) => ipcRenderer.send(IPC.fsUnwatch, watchId),
    onWatchEvent: (watchId, cb) => subscribe<DirListing>(`${IPC.fsWatchEvent}:${watchId}`, cb)
  },
  sftp: {
    list: (sid: string, path?: string): Promise<DirListing> =>
      ipcRenderer.invoke(IPC.sftpList, sid, path),
    home: (sid: string): Promise<string> => ipcRenderer.invoke(IPC.sftpHome, sid),
    mkdir: (sid: string, path: string): Promise<void> =>
      ipcRenderer.invoke(IPC.sftpMkdir, sid, path),
    createFile: (sid: string, path: string): Promise<void> =>
      ipcRenderer.invoke(IPC.sftpCreateFile, sid, path),
    rename: (sid: string, from: string, to: string): Promise<void> =>
      ipcRenderer.invoke(IPC.sftpRename, sid, from, to),
    delete: (sid: string, path: string): Promise<void> =>
      ipcRenderer.invoke(IPC.sftpDelete, sid, path),
    readFile: (sid: string, path: string): Promise<FileContent> =>
      ipcRenderer.invoke(IPC.sftpReadFile, sid, path),
    writeFile: (
      sid: string,
      path: string,
      content: string
    ): Promise<{ mtimeMs: number; size: number }> =>
      ipcRenderer.invoke(IPC.sftpWriteFile, sid, path, content),
    watch: (sid: string, path: string): Promise<string> =>
      ipcRenderer.invoke(IPC.sftpWatch, sid, path),
    unwatch: (watchId: string) => ipcRenderer.send(IPC.sftpUnwatch, watchId),
    onWatchEvent: (watchId, cb) => subscribe<DirListing>(`${IPC.sftpWatchEvent}:${watchId}`, cb)
  },
  transfer: {
    start: (opts: TransferStartOpts): Promise<string> =>
      ipcRenderer.invoke(IPC.transferStart, opts),
    cancel: (id: string) => ipcRenderer.send(IPC.transferCancel, id),
    onProgress: (id, cb) => subscribe<TransferProgress>(`${IPC.transferProgress}:${id}`, cb)
  },
  agent: {
    open: (opts: AgentOpenOpts): Promise<AgentOpenResult> =>
      ipcRenderer.invoke(IPC.agentOpen, opts),
    close: (sessionId: string) => ipcRenderer.send(IPC.agentClose, sessionId),
    setCwd: (sessionId: string, cwd: string) =>
      ipcRenderer.send(IPC.agentSetCwd, sessionId, cwd),
    status: (sessionId: string): Promise<AgentBridgeStatus | null> =>
      ipcRenderer.invoke(IPC.agentStatus, sessionId),
    onBridgeStatus: (sessionId, cb) =>
      subscribe<AgentBridgeStatus>(`${IPC.agentBridgeStatus}:${sessionId}`, cb),
    onConfirm: (cb) => subscribe<ConfirmRequest>(IPC.agentConfirm, cb),
    replyConfirm: (reqId: string, approved: boolean) =>
      ipcRenderer.send(IPC.agentConfirmReply, reqId, approved)
  },
  connections: {
    list: (): Promise<SavedConnection[]> => ipcRenderer.invoke(IPC.connectionsList),
    save: (conn: SavedConnection): Promise<SavedConnection[]> =>
      ipcRenderer.invoke(IPC.connectionsSave, conn),
    delete: (id: string): Promise<SavedConnection[]> =>
      ipcRenderer.invoke(IPC.connectionsDelete, id)
  },
  workspaces: {
    list: (): Promise<Workspace[]> => ipcRenderer.invoke(IPC.workspacesList),
    save: (ws: Workspace): Promise<Workspace[]> => ipcRenderer.invoke(IPC.workspacesSave, ws),
    delete: (id: string): Promise<Workspace[]> => ipcRenderer.invoke(IPC.workspacesDelete, id),
    rename: (id: string, name: string): Promise<Workspace[]> =>
      ipcRenderer.invoke(IPC.workspacesRename, id, name),
    duplicate: (id: string): Promise<Workspace[]> =>
      ipcRenderer.invoke(IPC.workspacesDuplicate, id),
    recordLaunch: (id: string): Promise<Workspace[]> =>
      ipcRenderer.invoke(IPC.workspacesRecordLaunch, id)
  },
  snippets: {
    list: (): Promise<Snippet[]> => ipcRenderer.invoke(IPC.snippetsList),
    save: (s: Snippet): Promise<Snippet[]> => ipcRenderer.invoke(IPC.snippetsSave, s),
    delete: (id: string): Promise<Snippet[]> => ipcRenderer.invoke(IPC.snippetsDelete, id)
  },
  history: {
    record: (command: string, scope: 'local' | 'remote'): Promise<void> =>
      ipcRenderer.invoke(IPC.historyRecord, command, scope),
    query: (q: HistoryQuery): Promise<HistoryResult> => ipcRenderer.invoke(IPC.historyQuery, q)
  },
  dialog: {
    chooseImage: (): Promise<string | null> => ipcRenderer.invoke(IPC.dialogChooseImage)
  },
  clipboard: {
    writeText: (text: string): Promise<void> => ipcRenderer.invoke(IPC.clipboardWrite, text),
    readText: (): Promise<string> => ipcRenderer.invoke(IPC.clipboardRead)
  },
  browser: {
    onOpenTab: (cb) => subscribe<{ sourceId: number; url: string }>(IPC.browserOpenTab, cb)
  },
  window: {
    setGlass: (enabled: boolean): Promise<void> => ipcRenderer.invoke(IPC.windowSetGlass, enabled)
  },
  localContext: (): Promise<HostContext> => ipcRenderer.invoke(IPC.localContext),
  platform: process.platform,

  // -------------------------------------------------------------------------
  // Foundation cluster additions (additive — see @shared/types)
  // -------------------------------------------------------------------------
  bridgeActivity: {
    on: (sessionId: string, cb: (entry: BridgeActivityEntry) => void): (() => void) =>
      subscribe<BridgeActivityEntry>(`${IPC.bridgeActivityEvent}:${sessionId}`, cb),
    list: (
      sessionId: string,
      opts?: { sinceMs?: number; limit?: number }
    ): Promise<BridgeActivityEntry[]> => ipcRenderer.invoke(IPC.bridgeActivityList, sessionId, opts),
    clear: (sessionId: string): Promise<void> =>
      ipcRenderer.invoke(IPC.bridgeActivityClear, sessionId)
  },
  settingsIo: {
    export: (): Promise<void> => ipcRenderer.invoke(IPC.settingsIoExport),
    import: (): Promise<{
      ok: boolean
      counts?: { settings: boolean; snippets: number; workspaces: number; approvalRules: number }
    }> => ipcRenderer.invoke(IPC.settingsIoImport)
  },
  approvalRules: {
    list: (sessionId?: string): Promise<ApprovalRule[]> =>
      ipcRenderer.invoke(IPC.approvalRules, { op: 'list', sessionId }),
    add: (rule: Omit<ApprovalRule, 'id' | 'createdAt'>): Promise<ApprovalRule[]> =>
      ipcRenderer.invoke(IPC.approvalRules, { op: 'add', rule }),
    remove: (id: string): Promise<ApprovalRule[]> =>
      ipcRenderer.invoke(IPC.approvalRules, { op: 'remove', id }),
    match: (sessionId: string, command: string): Promise<ApprovalRule | null> =>
      ipcRenderer.invoke(IPC.approvalRules, { op: 'match', sessionId, command })
  },
  portForward: {
    list: (sessionId?: string): Promise<PortForward[]> =>
      ipcRenderer.invoke(IPC.portForwardList, sessionId),
    // FOUNDATION: Cluster B will implement
    add: (req: Omit<PortForward, 'id' | 'createdAt' | 'bytes'>): Promise<PortForward> =>
      ipcRenderer.invoke(IPC.portForwardAdd, req) as Promise<PortForward>,
    // FOUNDATION: Cluster B will implement
    remove: (id: string): Promise<void> => ipcRenderer.invoke(IPC.portForwardRemove, id)
  },

  // -------------------------------------------------------------------------
  // Git awareness (read-only): status snapshot, per-file diff, and live push
  // notifications. Mutations (add/commit/push/checkout) are NOT exposed.
  // -------------------------------------------------------------------------
  git: {
    status: (target: { sessionId?: string; path: string }): Promise<GitStatus> =>
      ipcRenderer.invoke(IPC.gitStatus, target),
    diff: (target: { sessionId?: string; path: string; file: string }): Promise<string> =>
      ipcRenderer.invoke(IPC.gitDiff, target),
    /**
     * Subscribe to live status updates for `path`. The main process polls the
     * underlying source every 5s and only pushes when the snapshot changed.
     * Returns an unsubscribe; calling it is safe before the first event.
     */
    onChange: (path: string, cb: (status: GitStatus) => void): (() => void) => {
      // The renderer-side bookkeeping (which session owns the path) is open-
      // coded here; the main side uses an `add` invoke to start polling and a
      // `remove` to stop it. Path is the only renderer-side key.
      const channel = `${IPC.gitOnChange}:${path}`
      const off = subscribe<GitStatus>(channel, cb)
      return () => {
        off()
        // Best-effort: tell main we no longer care. Failure (e.g. main quit)
        // is fine — the next GC pass cleans the watch list.
        ipcRenderer.send(`${IPC.gitOnChange}:remove`, { path })
      }
    },
    /**
     * Start polling for `path`. Call once when the file tree starts showing
     * the directory; pair with the unsubscribe returned by `onChange`.
     */
    watch: (target: { sessionId?: string; path: string }): void => {
      ipcRenderer.send(`${IPC.gitOnChange}:add`, target)
    }
  },

  // -------------------------------------------------------------------------
  // Cluster D: persistent transfer queue + in-app browser enhancements
  // -------------------------------------------------------------------------
  transfers: {
    list: (): Promise<TransferListResult> => ipcRenderer.invoke(IPC.transfersList),
    enqueueUpload: (opts: { sessionId: string; localPath: string; remotePath: string }) =>
      ipcRenderer.invoke(IPC.transfersEnqueueUpload, opts) as Promise<TransferItemV2>,
    enqueueDownload: (opts: { sessionId: string; localPath: string; remotePath: string }) =>
      ipcRenderer.invoke(IPC.transfersEnqueueDownload, opts) as Promise<TransferItemV2>,
    cancel: (id: string): Promise<void> => ipcRenderer.invoke(IPC.transfersCancel, id),
    retry: (id: string): Promise<TransferItemV2 | null> =>
      ipcRenderer.invoke(IPC.transfersRetry, id) as Promise<TransferItemV2 | null>,
    clearFinished: (): Promise<TransferListResult> =>
      ipcRenderer.invoke(IPC.transfersClearFinished) as Promise<TransferListResult>,
    onProgress: (id: string, cb: (e: TransferEvent) => void): (() => void) =>
      subscribe<TransferEvent>(`${IPC.transfersEvent}:${id}`, cb),
    onStatus: (cb: (items: TransferListResult) => void): (() => void) => {
      // Match the existing namespaces' shape: subscribe to the broadcast
      // channel, then ask for the initial snapshot.
      const off = subscribe<void>(IPC.transfersStatus, () => {
        ipcRenderer.invoke(IPC.transfersList).then(cb).catch(() => undefined)
      })
      ipcRenderer.invoke(IPC.transfersList).then(cb).catch(() => undefined)
      return off
    }
  },
  browserDownloads: {
    list: (): Promise<BrowserDownloadItem[]> =>
      ipcRenderer.invoke(IPC.browserDownloadsList) as Promise<BrowserDownloadItem[]>,
    cancel: (id: string): Promise<void> => ipcRenderer.invoke(IPC.browserDownloadsCancel, id),
    onUpdate: (cb: (items: BrowserDownloadItem[]) => void): (() => void) => {
      const off = subscribe<BrowserDownloadItem[]>(IPC.browserDownloadsEvent, cb)
      ipcRenderer
        .invoke(IPC.browserDownloadsList)
        .then(cb)
        .catch(() => undefined)
      return off
    }
  },
  browserZoom: {
    get: (origin: string): Promise<number> => ipcRenderer.invoke(IPC.browserZoomGet, origin),
    set: (origin: string, level: number): Promise<void> =>
      ipcRenderer.invoke(IPC.browserZoomSet, origin, level) as Promise<void>,
    reset: (): Promise<void> => ipcRenderer.invoke(IPC.browserZoomReset)
  },
  openBrowserDevtools: (webContentsId: number): Promise<void> =>
    ipcRenderer.invoke(IPC.browserDevtoolsOpen, webContentsId),
  setBrowserMuted: (webContentsId: number, muted: boolean): Promise<void> =>
    ipcRenderer.invoke(IPC.browserMute, webContentsId, muted)
}

contextBridge.exposeInMainWorld('devterm', api)
