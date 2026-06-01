// Shared IPC + (future) MCP tool contracts between main, preload, and renderer.
// Keep this free of Electron/Node imports so both sides can import it.

export interface PtyCreateOptions {
  /** Optional shell override; main picks a sensible default per-OS when omitted. */
  shell?: string
  cwd?: string
  cols: number
  rows: number
}

export interface PtyCreated {
  id: string
  shell: string
}

// ---------------------------------------------------------------------------
// Host context (local vs remote, and which OS)
// ---------------------------------------------------------------------------

export type HostOS = 'windows' | 'linux' | 'mac' | 'unknown'

export interface HostContext {
  /** Where this session runs. */
  kind: 'local' | 'remote'
  os: HostOS
  /** Human-readable detail: `uname -a` output remotely, or platform/release locally. */
  detail: string
  /** Reported hostname (remote) or local machine name. */
  hostname: string
}

// ---------------------------------------------------------------------------
// SSH
// ---------------------------------------------------------------------------

export interface SSHHop {
  host: string
  port: number
  username: string
  password?: string
  /** Path to a private key file on the local machine. */
  privateKeyPath?: string
  passphrase?: string
}

export interface SSHProfile extends SSHHop {
  /** Stable id; if omitted on connect, one is generated. */
  id?: string
  name?: string
  /** Optional single bastion/ProxyJump hop. */
  jump?: SSHHop
}

export interface SSHConnectResult {
  sessionId: string
  context: HostContext
}

/**
 * A persisted SSH connection. Stored in userData (survives app updates);
 * secret fields are encrypted at rest via Electron safeStorage when available.
 */
export interface SavedConnection extends SSHProfile {
  id: string
  name: string
}

// ---------------------------------------------------------------------------
// Workspaces — saved presets of terminals to open together
// ---------------------------------------------------------------------------

/** A node in a workspace's saved split layout; leaf `tabs` are workspace-item ids. */
export type WorkspaceLayoutNode =
  | { type: 'leaf'; tabs: string[]; active?: string | null }
  | { type: 'split'; dir: 'row' | 'col'; sizes: number[]; children: WorkspaceLayoutNode[] }

/**
 * One terminal captured in a workspace. Local items reopen a local shell; remote
 * items reconnect a saved SSH connection. `id` is stable within the workspace and
 * is what the saved `layout` leaves reference (so the same item can be placed in
 * the split tree regardless of kind). No secrets are stored — remote items only
 * carry a saved-connection id.
 */
export interface WorkspaceItem {
  /** Stable id within the workspace; referenced by layout leaf `tabs`. */
  id: string
  kind: 'local' | 'remote'
  /** Remote items: the saved-connection id to reconnect. */
  connectionId?: string
  /** Best-effort working directory to restore (from OSC 7 tracking at capture). */
  cwd?: string
  /** Display label at capture time (for the workspace list). */
  title?: string
}

/**
 * A named snapshot of a terminal arrangement the user works in. Captures the open
 * local + remote terminals, their working directories, and the split layout, and
 * re-opens the whole set on launch. Persisted in userData (no secrets — only
 * saved-connection ids and cwds are stored).
 */
export interface Workspace {
  id: string
  name: string
  /** Terminals included, in tab order. */
  items: WorkspaceItem[]
  /** Optional saved split arrangement (leaf tabs are workspace-item ids). */
  layout?: WorkspaceLayoutNode | null
  /**
   * Legacy field from pre-1.0.1 remote-only workspaces; read on load and migrated
   * into `items`. Never written by current code.
   */
  connectionIds?: string[]
}

// ---------------------------------------------------------------------------
// Snippets — saved command scriptlets
// ---------------------------------------------------------------------------

/**
 * A saved command scriptlet, run or inserted into the active terminal. `command`
 * may contain `{{token}}` placeholders that are filled in (via a small prompt)
 * before sending. Persisted in userData with no encryption — like workspaces,
 * don't store secrets in a snippet.
 */
export interface Snippet {
  id: string
  name: string
  /** The command text; may contain {{placeholder}} tokens. */
  command: string
  description?: string
  /** Free-form tags, used for filtering in the command palette. */
  tags?: string[]
}

/** Non-fatal events surfaced to the renderer during a connection's life. */
export type SSHStatus =
  | { type: 'hostkey-new'; host: string; fingerprint: string }
  | { type: 'hostkey-mismatch'; host: string; fingerprint: string; expected: string }
  | { type: 'error'; message: string }
  | { type: 'closed' }

// ---------------------------------------------------------------------------
// Files (SFTP remote + local fs) and transfers
// ---------------------------------------------------------------------------

export interface FileEntry {
  name: string
  /** Full POSIX path (remote) or native path (local). */
  path: string
  isDir: boolean
  isSymlink: boolean
  size: number
  mtimeMs: number
  /** rwx-style permission string, e.g. "drwxr-xr-x". */
  mode: string
}

export interface DirListing {
  /** The (resolved) directory that was listed. */
  path: string
  /** Parent path, or null at the root. */
  parent: string | null
  entries: FileEntry[]
}

export type TransferDirection = 'upload' | 'download'

/** In-memory contents of a file opened for editing. */
export interface FileContent {
  /** The (resolved) path that was read. */
  path: string
  /** UTF-8 text contents. */
  content: string
  /** Byte size of the file on disk. */
  size: number
  /** mtime in ms at read time (for stale-write detection by the UI). */
  mtimeMs: number
  /** Trailing newline style detected in the original, to preserve on save. */
  eol: '\n' | '\r\n'
}

/** Max bytes a file may be to open in the editor (larger files are rejected). */
export const MAX_EDIT_BYTES = 5 * 1024 * 1024

// ---------------------------------------------------------------------------
// Claude agent bridge
// ---------------------------------------------------------------------------

export type PolicyMode = 'read_only' | 'confirm' | 'full'

export interface ClaudeOpenOpts {
  sessionId: string
  mode: PolicyMode
  /** Tell the agent the host has no internet. Optional; defaults to false. */
  airGapped?: boolean
  cols: number
  rows: number
}

export interface ClaudeOpenResult {
  /** PTY id of the spawned interactive `claude` (use the pty.* channels). */
  ptyId: string
  mcpUrl: string
}

/** A guarded action awaiting operator approval (confirm mode / destructive op). */
export interface ConfirmRequest {
  reqId: string
  sessionId: string
  tool: string
  detail: string
}

export interface TransferStartOpts {
  direction: TransferDirection
  sessionId: string
  localPath: string
  remotePath: string
}

export interface TransferProgress {
  id: string
  transferred: number
  total: number
  done: boolean
  canceled?: boolean
  error?: string
}

// ---------------------------------------------------------------------------
// IPC channel names — single source of truth for both ends.
// ---------------------------------------------------------------------------

export const IPC = {
  // local PTY
  ptyCreate: 'pty:create',
  ptyInput: 'pty:input',
  ptyResize: 'pty:resize',
  ptyKill: 'pty:kill',
  ptyData: 'pty:data', // suffixed :<id>
  ptyExit: 'pty:exit', // suffixed :<id>

  // local context
  localContext: 'ctx:local',

  // ssh
  sshConnect: 'ssh:connect',
  sshOpenShell: 'ssh:openShell',
  sshInput: 'ssh:input',
  sshResize: 'ssh:resize',
  sshDisconnect: 'ssh:disconnect',
  sshData: 'ssh:data', // suffixed :<sessionId>
  sshExit: 'ssh:exit', // suffixed :<sessionId>
  sshStatus: 'ssh:status', // suffixed :<sessionId>

  // local filesystem
  fsList: 'fs:list',
  fsHome: 'fs:home',
  fsMkdir: 'fs:mkdir',
  fsCreateFile: 'fs:createFile',
  fsRename: 'fs:rename',
  fsDelete: 'fs:delete',
  fsReadFile: 'fs:readFile',
  fsWriteFile: 'fs:writeFile',

  // remote filesystem (SFTP on the session's existing client)
  sftpList: 'sftp:list',
  sftpHome: 'sftp:home',
  sftpMkdir: 'sftp:mkdir',
  sftpCreateFile: 'sftp:createFile',
  sftpRename: 'sftp:rename',
  sftpDelete: 'sftp:delete',
  sftpReadFile: 'sftp:readFile',
  sftpWriteFile: 'sftp:writeFile',

  // transfers
  transferStart: 'transfer:start',
  transferCancel: 'transfer:cancel',
  transferProgress: 'transfer:progress', // suffixed :<transferId>

  // claude agent bridge
  claudeOpen: 'claude:open',
  claudeClose: 'claude:close',
  claudeConfirm: 'claude:confirm', // main -> renderer
  claudeConfirmReply: 'claude:confirm:reply', // renderer -> main

  // saved connections (persisted in userData)
  connectionsList: 'connections:list',
  connectionsSave: 'connections:save',
  connectionsDelete: 'connections:delete',

  // workspaces (persisted in userData)
  workspacesList: 'workspaces:list',
  workspacesSave: 'workspaces:save',
  workspacesDelete: 'workspaces:delete',

  // snippets (persisted in userData)
  snippetsList: 'snippets:list',
  snippetsSave: 'snippets:save',
  snippetsDelete: 'snippets:delete',

  // native dialogs
  dialogChooseImage: 'dialog:chooseImage',

  // system clipboard
  clipboardWrite: 'clipboard:write',
  clipboardRead: 'clipboard:read',

  // in-app browser: a guest page asked to open a new window → open it as a tab
  browserOpenTab: 'browser:open-tab',

  // window appearance (glass/translucent material)
  windowSetGlass: 'window:set-glass',

  // custom window controls (frameless titlebar)
  windowMinimize: 'window:minimize',
  windowToggleMaximize: 'window:toggle-maximize',
  windowClose: 'window:close',
  windowIsMaximized: 'window:is-maximized',
  windowMaximizeChanged: 'window:maximize-changed' // main -> renderer
} as const

/** Typed surface exposed to the renderer via contextBridge (see preload). */
export interface DevTermApi {
  pty: {
    create(opts: PtyCreateOptions): Promise<PtyCreated>
    input(id: string, data: string): void
    resize(id: string, cols: number, rows: number): void
    kill(id: string): void
    onData(id: string, cb: (data: string) => void): () => void
    onExit(id: string, cb: (e: { exitCode: number; signal?: number }) => void): () => void
  }
  ssh: {
    connect(profile: SSHProfile): Promise<SSHConnectResult>
    openShell(sessionId: string, cols: number, rows: number): Promise<void>
    input(sessionId: string, data: string): void
    resize(sessionId: string, cols: number, rows: number): void
    disconnect(sessionId: string): void
    onData(sessionId: string, cb: (data: string) => void): () => void
    onExit(sessionId: string, cb: () => void): () => void
    onStatus(sessionId: string, cb: (s: SSHStatus) => void): () => void
  }
  /** Local filesystem browsing. */
  fs: {
    list(path?: string): Promise<DirListing>
    home(): Promise<string>
    mkdir(path: string): Promise<void>
    /** Create an empty file; rejects if a file/dir already exists at `path`. */
    createFile(path: string): Promise<void>
    rename(from: string, to: string): Promise<void>
    delete(path: string): Promise<void>
    readFile(path: string): Promise<FileContent>
    writeFile(path: string, content: string): Promise<{ mtimeMs: number; size: number }>
  }
  /** Remote filesystem over SFTP (shares the session's SSH client). */
  sftp: {
    list(sessionId: string, path?: string): Promise<DirListing>
    home(sessionId: string): Promise<string>
    mkdir(sessionId: string, path: string): Promise<void>
    /** Create an empty file; rejects if a file/dir already exists at `path`. */
    createFile(sessionId: string, path: string): Promise<void>
    rename(sessionId: string, from: string, to: string): Promise<void>
    delete(sessionId: string, path: string): Promise<void>
    readFile(sessionId: string, path: string): Promise<FileContent>
    writeFile(
      sessionId: string,
      path: string,
      content: string
    ): Promise<{ mtimeMs: number; size: number }>
  }
  /** Streamed upload/download with progress + cancel. */
  transfer: {
    start(opts: TransferStartOpts): Promise<string>
    cancel(id: string): void
    onProgress(id: string, cb: (p: TransferProgress) => void): () => void
  }
  /** Claude agent bridge: spawn interactive `claude` wired to the MCP bridge. */
  claude: {
    open(opts: ClaudeOpenOpts): Promise<ClaudeOpenResult>
    close(sessionId: string): void
    onConfirm(cb: (req: ConfirmRequest) => void): () => void
    replyConfirm(reqId: string, approved: boolean): void
  }
  /** Persisted SSH connections (CRUD); each call returns the full updated list. */
  connections: {
    list(): Promise<SavedConnection[]>
    save(conn: SavedConnection): Promise<SavedConnection[]>
    delete(id: string): Promise<SavedConnection[]>
  }
  /** Persisted terminal workspaces (CRUD); each call returns the full updated list. */
  workspaces: {
    list(): Promise<Workspace[]>
    save(ws: Workspace): Promise<Workspace[]>
    delete(id: string): Promise<Workspace[]>
  }
  /** Persisted command snippets (CRUD); each call returns the full updated list. */
  snippets: {
    list(): Promise<Snippet[]>
    save(s: Snippet): Promise<Snippet[]>
    delete(id: string): Promise<Snippet[]>
  }
  /** Native OS dialogs. */
  dialog: {
    /** Open an image picker; resolves to a `data:` URL of the chosen file, or null if canceled. */
    chooseImage(): Promise<string | null>
  }
  /** System clipboard (the sandboxed renderer can't reach Electron's clipboard directly). */
  clipboard: {
    writeText(text: string): Promise<void>
    readText(): Promise<string>
  }
  /** In-app browser pane plumbing. */
  browser: {
    /**
     * Fires when a guest webview page tries to open a new window (target=_blank,
     * window.open, "open in new tab"). `sourceId` is the originating guest's
     * webContents id, so the renderer can add the tab to the right pane.
     */
    onOpenTab(cb: (e: { sourceId: number; url: string }) => void): () => void
  }
  /** Window appearance + custom controls (the window is frameless). */
  window: {
    /**
     * Toggle a translucent window material for the glass theme. Enables native
     * Acrylic/Mica where the Electron build supports `setBackgroundMaterial`
     * (Electron ≥30); a no-op otherwise, where the CSS glass layer still applies.
     */
    setGlass(enabled: boolean): Promise<void>
    minimize(): void
    toggleMaximize(): void
    close(): void
    isMaximized(): Promise<boolean>
    /** Fires with the new maximized state when the window is maximized/restored. */
    onMaximizeChange(cb: (maximized: boolean) => void): () => void
  }
  /** Context of the local workstation. */
  localContext(): Promise<HostContext>
  platform: NodeJS.Platform
}
