import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC,
  type DevTermApi,
  type PtyCreateOptions,
  type PtyCreated,
  type SSHProfile,
  type SSHConnectResult,
  type SSHStatus,
  type HostContext,
  type DirListing,
  type FileContent,
  type TransferStartOpts,
  type TransferProgress,
  type ClaudeOpenOpts,
  type ClaudeOpenResult,
  type ConfirmRequest,
  type SavedConnection,
  type Workspace,
  type Snippet
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
  claude: {
    open: (opts: ClaudeOpenOpts): Promise<ClaudeOpenResult> =>
      ipcRenderer.invoke(IPC.claudeOpen, opts),
    close: (sessionId: string) => ipcRenderer.send(IPC.claudeClose, sessionId),
    onConfirm: (cb) => subscribe<ConfirmRequest>(IPC.claudeConfirm, cb),
    replyConfirm: (reqId: string, approved: boolean) =>
      ipcRenderer.send(IPC.claudeConfirmReply, reqId, approved)
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
    delete: (id: string): Promise<Workspace[]> => ipcRenderer.invoke(IPC.workspacesDelete, id)
  },
  snippets: {
    list: (): Promise<Snippet[]> => ipcRenderer.invoke(IPC.snippetsList),
    save: (s: Snippet): Promise<Snippet[]> => ipcRenderer.invoke(IPC.snippetsSave, s),
    delete: (id: string): Promise<Snippet[]> => ipcRenderer.invoke(IPC.snippetsDelete, id)
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
    setGlass: (enabled: boolean): Promise<void> => ipcRenderer.invoke(IPC.windowSetGlass, enabled),
    minimize: () => ipcRenderer.send(IPC.windowMinimize),
    toggleMaximize: () => ipcRenderer.send(IPC.windowToggleMaximize),
    close: () => ipcRenderer.send(IPC.windowClose),
    isMaximized: (): Promise<boolean> => ipcRenderer.invoke(IPC.windowIsMaximized),
    onMaximizeChange: (cb) => subscribe<boolean>(IPC.windowMaximizeChanged, cb)
  },
  localContext: (): Promise<HostContext> => ipcRenderer.invoke(IPC.localContext),
  platform: process.platform
}

contextBridge.exposeInMainWorld('devterm', api)
