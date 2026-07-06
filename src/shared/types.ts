// Shared IPC + (future) MCP tool contracts between main, preload, and renderer.
// Keep this free of Electron/Node imports so both sides can import it.

export interface PtyCreateOptions {
  /** Optional shell override (absolute path); main picks a sensible default per-OS when omitted. */
  shell?: string
  /**
   * Optional user default-shell preference. The main process resolves this to
   * an absolute path (preferring installed shells in the documented order),
   * falling back to `shell` and then to the OS default. `auto` means "pick the
   * best installed shell" — PowerShell 7 if present, else Windows PowerShell,
   * else cmd.exe on Windows; on POSIX, `$SHELL`. `custom` is a free-form path
   * (wsl.exe, Git Bash, nushell, …).
   */
  shellPref?: DefaultShellPref
  cwd?: string
  cols: number
  rows: number
}

/**
 * User's preferred local shell. Mirrors the renderer's settings-store shape
 * so the IPC can pass it through unchanged; `main/pty/manager.ts` resolves it
 * to an absolute path. See `defaultShell()` for the auto-pick order.
 */
export type DefaultShellPref =
  | { kind: 'auto' }
  | { kind: 'pwsh' }
  | { kind: 'powershell' }
  | { kind: 'cmd' }
  | { kind: 'custom'; path: string }

export interface PtyCreated {
  id: string
  shell: string
}

/**
 * Why a freshly-spawned PTY exited before emitting any data. Carries enough
 * context for the renderer to render a targeted diagnostic instead of the
 * generic "[process exited]" notice — Windows PowerShell 5.1's managed
 * signature failure (`NTE_BAD_SIGNATURE` / 0x8009001d, often from antivirus
 * tampering) shows up here. The main process watches for "no data, just an
 * exit" within a short health window and fires this; the renderer matches
 * it to its session id.
 */
export interface PtyStartupFailure {
  /** The shell that was launched (absolute path). */
  shell: string
  /** Exit code reported by the process; undefined if ConPTY tore down without one. */
  exitCode?: number
  /** Signal that killed the process, if any. */
  signal?: number
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

/**
 * Auto-reconnect policy for SSH sessions. Pushed from the renderer (settings
 * modal) into the main process; the same struct is returned by the policy
 * IPC so both ends stay in sync.
 */
export interface ReconnectPolicy {
  /** Master switch — when off, drops are terminal. */
  enabled: boolean
  /** Max attempts (including the first retry) before giving up. */
  maxAttempts: number
  /** Initial delay before the first retry, in ms. */
  baseDelayMs: number
  /** Cap for any single delay, in ms (the backoff is clamped here). */
  maxDelayMs: number
  /** Multiplier per attempt. 1 = constant delay, 2 = classic exponential. */
  factor: number
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
  /** Optional free-form description (shown in the manager row). */
  description?: string
  /** Terminals included, in tab order. */
  items: WorkspaceItem[]
  /** Optional saved split arrangement (leaf tabs are workspace-item ids). */
  layout?: WorkspaceLayoutNode | null
  /**
   * Legacy field from pre-1.0.1 remote-only workspaces; read on load and migrated
   * into `items`. Never written by current code.
   */
  connectionIds?: string[]
  /** Wall-clock time (ms since epoch) of the most recent launch; undefined if never. */
  lastLaunchedAt?: number
  /** Number of times this workspace has been launched (incremented on every launch). */
  launchCount?: number
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

// ---------------------------------------------------------------------------
// Command history — recent & most-used commands for the palette
// ---------------------------------------------------------------------------

/** A command paired with how often it's been seen (for "most used" ranking). */
export interface CommandStat {
  command: string
  count: number
}

/**
 * Which history to read. `local` reads the machine's own shell history (and
 * in-app local runs); `remote` reads a connected SSH session's shell history
 * (over its existing client) plus in-app remote runs.
 */
export type HistoryQuery = { scope: 'local' } | { scope: 'remote'; sessionId: string }

/** Merged command history for a scope: most-recent-first and most-used-first. */
export interface HistoryResult {
  /** Distinct commands, most recent first. */
  recent: string[]
  /** Distinct commands ranked by frequency, most used first. */
  frequent: CommandStat[]
}

/** Non-fatal events surfaced to the renderer during a connection's life. */
export type SSHStatus =
  | { type: 'hostkey-new'; host: string; fingerprint: string }
  | { type: 'hostkey-mismatch'; host: string; fingerprint: string; expected: string }
  | { type: 'error'; message: string }
  | { type: 'closed' }
  | {
      /** Auto-reconnect is in flight; the connection is about to be re-established. */
      type: 'reconnecting'
      /** 1-based attempt number (1 = first retry). */
      attempt: number
      /** Max attempts the manager will try before giving up. */
      maxAttempts: number
      /** Delay (ms) until the next attempt. */
      delayMs: number
    }
  | {
      /** Auto-reconnect succeeded and a fresh session is up. */
      type: 'reconnected'
      attempt: number
    }
  | {
      /** Auto-reconnect gave up after exhausting attempts. */
      type: 'reconnect-failed'
      attempts: number
      reason: string
    }

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
// Agent bridge: an interactive coding-agent CLI wired to the in-process MCP
// bridge. DevTerm can launch either the `claude` CLI or the `pi` CLI; the user
// picks per session. The MCP bridge, tools, and policy are agent-agnostic —
// they speak MCP. The renderer-visible contract below is the only place the
// agent's identity leaks out, and the IPC channel names are pure strings with
// no agent-specific bits.
// ---------------------------------------------------------------------------

export type PolicyMode = 'read_only' | 'confirm' | 'full'

/**
 * Which coding agent to spawn for a session. `claude` runs the Claude CLI
 * (Anthropic-only, native MCP via --mcp-config); `pi` runs the pi coding agent
 * (more models/subscriptions, MCP via a loaded extension); `opencode` runs the
 * OpenCode TUI (sst/opencode) wired to the bridge through a per-session
 * `opencode.json` with a remote MCP server entry; `kimi` runs the Kimi Code CLI
 * (Moonshot AI) wired through a per-session `.kimi-code/mcp.json`. All four
 * reach this host only through DevTerm's MCP bridge.
 */
export type AgentKind = 'claude' | 'pi' | 'opencode' | 'kimi'

export interface AgentOpenOpts {
  sessionId: string
  /** Which agent CLI to launch. */
  kind: AgentKind
  mode: PolicyMode
  /** Tell the agent the host has no internet. Optional; defaults to false. */
  airGapped?: boolean
  /**
   * The remote shell's current working directory at launch (from OSC 7), so the
   * agent's commands start where the operator is. Live updates flow over
   * `agent:set-cwd`. Optional: omitted until the shell reports a cwd.
   */
  cwd?: string
  cols: number
  rows: number
}

export interface AgentOpenResult {
  /** PTY id of the spawned interactive agent (use the pty.* channels). */
  ptyId: string
  mcpUrl: string
}

export type AgentBridgeState =
  | 'starting'
  | 'listening'
  | 'connected'
  | 'disconnected'
  | 'stopped'
  | 'error'

export interface AgentBridgeStatus {
  state: AgentBridgeState
  mcpUrl?: string
  message?: string
  lastActivityAt?: number
  lastHeartbeatAt?: number
  activeStreams: number
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
  /**
   * Fired when a freshly-spawned PTY exited without ever producing data —
   * the typical Windows PowerShell 5.1 managed-signature failure
   * (0x8009001d). Pairs with the renderer-side diagnostic that suggests
   * installing PowerShell 7 or switching the default shell.
   */
  ptyStartupFailure: 'pty:startup-failure', // suffixed :<id>

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
  sshCancelReconnect: 'ssh:cancel-reconnect', // <sessionId>
  sshGetReconnectPolicy: 'ssh:get-reconnect-policy',
  sshSetReconnectPolicy: 'ssh:set-reconnect-policy',

  // local filesystem
  fsList: 'fs:list',
  fsHome: 'fs:home',
  fsMkdir: 'fs:mkdir',
  fsCreateFile: 'fs:createFile',
  fsRename: 'fs:rename',
  fsDelete: 'fs:delete',
  fsReadFile: 'fs:readFile',
  fsWriteFile: 'fs:writeFile',
  fsWatch: 'fs:watch',
  fsUnwatch: 'fs:unwatch',
  fsWatchEvent: 'fs:watch:event', // suffixed :<watchId>

  // remote filesystem (SFTP on the session's existing client)
  sftpList: 'sftp:list',
  sftpHome: 'sftp:home',
  sftpMkdir: 'sftp:mkdir',
  sftpCreateFile: 'sftp:createFile',
  sftpRename: 'sftp:rename',
  sftpDelete: 'sftp:delete',
  sftpReadFile: 'sftp:readFile',
  sftpWriteFile: 'sftp:writeFile',
  sftpWatch: 'sftp:watch',
  sftpUnwatch: 'sftp:unwatch',
  sftpWatchEvent: 'sftp:watch:event', // suffixed :<watchId>

  // transfers
  transferStart: 'transfer:start',
  transferCancel: 'transfer:cancel',
  transferProgress: 'transfer:progress', // suffixed :<transferId>

  // agent bridge (interactive `pi` wired to the in-process MCP bridge)
  agentOpen: 'agent:open',
  agentClose: 'agent:close',
  agentConfirm: 'agent:confirm', // main -> renderer
  agentConfirmReply: 'agent:confirm:reply', // renderer -> main
  agentBridgeStatus: 'agent:bridge-status', // suffixed :<sessionId>
  agentStatus: 'agent:status',
  agentSetCwd: 'agent:set-cwd', // renderer -> main: live working-directory updates

  // saved connections (persisted in userData)
  connectionsList: 'connections:list',
  connectionsSave: 'connections:save',
  connectionsDelete: 'connections:delete',

  // workspaces (persisted in userData)
  workspacesList: 'workspaces:list',
  workspacesSave: 'workspaces:save',
  workspacesDelete: 'workspaces:delete',
  /** Cluster B: rename a workspace in place; returns the full updated list. */
  workspacesRename: 'workspaces:rename',
  /** Cluster B: duplicate a workspace with a new id + " (copy)" suffix; returns the full updated list. */
  workspacesDuplicate: 'workspaces:duplicate',
  /** Cluster B: record a launch (increments launchCount, sets lastLaunchedAt); returns the full updated list. */
  workspacesRecordLaunch: 'workspaces:record-launch',

  // snippets (persisted in userData)
  snippetsList: 'snippets:list',
  snippetsSave: 'snippets:save',
  snippetsDelete: 'snippets:delete',

  // command history (in-app capture in userData + the host's shell-history files)
  historyRecord: 'history:record',
  historyQuery: 'history:query',

  // native dialogs
  dialogChooseImage: 'dialog:chooseImage',

  // system clipboard
  clipboardWrite: 'clipboard:write',
  clipboardRead: 'clipboard:read',
  clipboardSaveImage: 'clipboard:saveImage',

  // in-app browser: a guest page asked to open a new window → open it as a tab
  browserOpenTab: 'browser:open-tab',

  // window appearance (glass/translucent material)
  windowSetGlass: 'window:set-glass',
  // attention: OS notification + taskbar flash when an agent/terminal wants the
  // operator and the window is in the background
  windowFlashAttention: 'window:flash-attention',

  // foundation cluster: bridge activity log
  bridgeActivityList: 'bridge-activity:list',
  bridgeActivityClear: 'bridge-activity:clear',
  bridgeActivityEvent: 'bridge-activity:event', // suffixed :<sessionId>

  // foundation cluster: settings export/import
  settingsIoExport: 'settings-io:export',
  settingsIoImport: 'settings-io:import',
  settingsImported: 'settings:imported',

  // foundation cluster: approval rules (action-style single channel)
  approvalRules: 'approval-rules',

  // foundation cluster: port forwards (stubs; Cluster B will implement)
  portForwardList: 'port-forward:list',
  portForwardAdd: 'port-forward:add',
  portForwardRemove: 'port-forward:remove',

  // git status (read-only) — local and remote (mirrored over the session's exec channel)
  gitStatus: 'git:status',
  gitDiff: 'git:diff',
  gitOnChange: 'git:on-change', // suffixed :<path>

  // Cluster D: persistent transfer queue
  transfersList: 'transfers:list',
  transfersEnqueueUpload: 'transfers:enqueue-upload',
  transfersEnqueueDownload: 'transfers:enqueue-download',
  transfersCancel: 'transfers:cancel',
  transfersRetry: 'transfers:retry',
  transfersClearFinished: 'transfers:clear-finished',
  transfersEvent: 'transfers:event', // suffixed :<id>
  transfersStatus: 'transfers:status',
  // Cluster D: in-app browser enhancements
  browserDownloadsList: 'browser:downloads:list',
  browserDownloadsCancel: 'browser:downloads:cancel',
  browserZoomGet: 'browser:zoom:get',
  browserZoomSet: 'browser:zoom:set',
  browserZoomReset: 'browser:zoom:reset',
  browserDevtoolsOpen: 'browser:devtools:open',
  browserMute: 'browser:mute',
  browserOpenExternal: 'browser:open-external',
  browserDownloadsEvent: 'browser:downloads:event',
  searchQuery: 'search:query',
  searchSeed: 'search:seed'
} as const

/** Typed surface exposed to the renderer via contextBridge (see preload). */
export interface DevTermApi {
  pty: {
    create(opts: PtyCreateOptions): Promise<PtyCreated>
    input(id: string, data: string): void
    resize(id: string, cols: number, rows: number): void
    kill(id: string): void
    onData(id: string, cb: (data: string) => void): () => void
    // exitCode is undefined when ConPTY tears down without a real process exit
    // (e.g. the console host died under a misbehaving TUI).
    onExit(
      id: string,
      cb: (e: { exitCode: number | undefined; signal?: number }) => void
    ): () => void
    /**
     * Fires once if a fresh PTY exited without ever producing data — the
     * classic "Windows PowerShell failed to start" pattern (typically the
     * managed-signature 0x8009001d error). The renderer uses this to render
     * a targeted diagnostic with a copy-pasteable fix instead of the generic
     * exit notice. Always paired with `onExit`; the regular exit handler
     * still fires so the pane can clean up.
     */
    onStartupFailure(id: string, cb: (info: PtyStartupFailure) => void): () => void
  }
  ssh: {
    connect(profile: SSHProfile): Promise<SSHConnectResult>
    openShell(sessionId: string, cols: number, rows: number): Promise<void>
    input(sessionId: string, data: string): void
    resize(sessionId: string, cols: number, rows: number): void
    disconnect(sessionId: string): void
    cancelReconnect(sessionId: string): void
    getReconnectPolicy(): Promise<ReconnectPolicy>
    setReconnectPolicy(patch: Partial<ReconnectPolicy>): Promise<ReconnectPolicy>
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
    /** Start watching a directory for live changes; resolves to a watch id. */
    watch(path: string): Promise<string>
    /** Stop a watch started with `watch`. */
    unwatch(watchId: string): void
    /** Subscribe to fresh listings pushed when the watched directory changes. */
    onWatchEvent(watchId: string, cb: (listing: DirListing) => void): () => void
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
    /** Start watching a remote directory for live changes; resolves to a watch id. */
    watch(sessionId: string, path: string): Promise<string>
    /** Stop a watch started with `watch`. */
    unwatch(watchId: string): void
    /** Subscribe to fresh listings pushed when the watched directory changes. */
    onWatchEvent(watchId: string, cb: (listing: DirListing) => void): () => void
  }
  /** Streamed upload/download with progress + cancel. */
  transfer: {
    start(opts: TransferStartOpts): Promise<string>
    cancel(id: string): void
    onProgress(id: string, cb: (p: TransferProgress) => void): () => void
  }
  /** Agent bridge: spawn interactive `pi` wired to the in-process MCP bridge. */
  agent: {
    open(opts: AgentOpenOpts): Promise<AgentOpenResult>
    close(sessionId: string): void
    /** Push the remote shell's live cwd so the agent's commands follow the operator's `cd`. */
    setCwd(sessionId: string, cwd: string): void
    status(sessionId: string): Promise<AgentBridgeStatus | null>
    onBridgeStatus(sessionId: string, cb: (status: AgentBridgeStatus) => void): () => void
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
    /** Cluster B: rename a workspace in place. */
    rename(id: string, name: string): Promise<Workspace[]>
    /** Cluster B: duplicate a workspace; the new copy has " (copy)" appended to the name. */
    duplicate(id: string): Promise<Workspace[]>
    /** Cluster B: record that a workspace was launched; bumps launchCount + lastLaunchedAt. */
    recordLaunch(id: string): Promise<Workspace[]>
  }
  /** Persisted command snippets (CRUD); each call returns the full updated list. */
  snippets: {
    list(): Promise<Snippet[]>
    save(s: Snippet): Promise<Snippet[]>
    delete(id: string): Promise<Snippet[]>
  }
  /**
   * Command history for the palette: recent + most-used commands, merged from
   * commands run through DevTerm (recorded here) and the host's own shell-history
   * files (PSReadLine locally; ~/.bash_history / ~/.zsh_history on a remote).
   */
  history: {
    /** Record a command actually executed via DevTerm; scope keeps local/remote separate. */
    record(command: string, scope: 'local' | 'remote'): Promise<void>
    /** Recent + most-used commands for a scope (the local machine or a remote session). */
    query(q: HistoryQuery): Promise<HistoryResult>
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
    /**
     * If the system clipboard holds an image (e.g. a screenshot), save it to a
     * temp PNG and return the absolute path; otherwise null. Used by terminal
     * paste so a coding agent in the shell can attach a pasted image by path
     * (xterm can't forward binary image data through the PTY).
     */
    saveImage(): Promise<string | null>
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
  /** Window appearance hooks. Native window controls are owned by the OS frame. */
  window: {
    /**
     * Toggle a translucent window material for the glass theme. Enables native
     * Acrylic/Mica where the Electron build supports `setBackgroundMaterial`
     * (Electron ≥30); a no-op otherwise, where the CSS glass layer still applies.
     */
    setGlass(enabled: boolean): Promise<void>
    /**
     * Pull the operator back to a backgrounded window: flash the taskbar button
     * and post an OS notification (clicking it focuses the window). A no-op when
     * the window is already focused. Used by the agent/terminal attention signal
     * so a finished or input-waiting agent surfaces even when DevTerm is hidden.
     */
    flashAttention(notice: { title: string; body?: string }): void
  }
  /** Context of the local workstation. */
  localContext(): Promise<HostContext>
  platform: NodeJS.Platform

  // -------------------------------------------------------------------------
  // Foundation cluster additions (additive — do not edit the namespace above)
  // -------------------------------------------------------------------------

  /**
   * Bridge activity log (tool calls, approval requests, heartbeats, etc.) per
   * session. Subscribed via the per-session channel and read on demand.
   */
  bridgeActivity: {
    on(sessionId: string, cb: (entry: BridgeActivityEntry) => void): () => void
    list(
      sessionId: string,
      opts?: { sinceMs?: number; limit?: number }
    ): Promise<BridgeActivityEntry[]>
    clear(sessionId: string): Promise<void>
  }
  /**
   * Settings export/import. Pops a native save/open dialog; the bundle is
   * versioned (see `SettingsExportBundle`) and secrets are stripped on export.
   */
  settingsIo: {
    export(): Promise<string | null>
    import(): Promise<{
      ok: boolean
      error?: string
      counts?: { settings: boolean; snippets: number; workspaces: number; approvalRules: number }
    }>
    onImported(cb: () => void): () => void
  }
  /**
   * Approval rules for the agent guardrail. Scoped per-session or global
   * (sessionId omitted). Longest-prefix match on `commandPrefix`.
   */
  approvalRules: {
    list(sessionId?: string): Promise<ApprovalRule[]>
    add(rule: Omit<ApprovalRule, 'id' | 'createdAt'>): Promise<ApprovalRule[]>
    remove(id: string): Promise<ApprovalRule[]>
    match(sessionId: string, command: string): Promise<ApprovalRule | null>
  }
  /**
   * SSH port forwarding. `list` is real; `add` and `remove` are stubbed until
   * Cluster B wires them through to the existing ssh2 client.
   */
  portForward: {
    list(sessionId?: string): Promise<PortForward[]>
    add(req: Omit<PortForward, 'id' | 'createdAt' | 'bytes'>): Promise<PortForward>
    remove(id: string): Promise<void>
  }

  /**
   * Read-only git awareness for the file tree. `status` returns the current
   * branch + a path→status map for the given working dir (local or remote);
   * `diff` returns the textual diff for one file. `onChange` subscribes to live
   * updates — the main process polls the source every few seconds and pushes
   * the latest status to the matching renderer.
   */
  git: {
    /**
     * Resolve git status. `sessionId` is omitted for local paths; present for
     * remote ones (the lookup runs over the session's existing exec channel).
     */
    status(target: { sessionId?: string; path: string }): Promise<GitStatus>
    /**
     * Resolve the textual diff for one tracked file. For unstaged/untracked
     * paths the diff is best-effort (may be empty for untracked files).
     */
    diff(target: { sessionId?: string; path: string; file: string }): Promise<string>
    /**
     * Subscribe to status changes for a given working dir. The main process
     * polls every 5s and pushes an updated `GitStatus` whenever it changes.
     * Pass the same `target` you pass to `watch()` so the subscription is scoped
     * per session+path (a local and a remote repo at the same path don't collide)
     * and the unsubscribe stops the right poll.
     */
    onChange(
      target: { sessionId?: string; path: string },
      cb: (status: GitStatus) => void
    ): () => void
    /**
     * Explicit "start polling" nudge for `path`. Pair with the unsubscribe
     * returned by `onChange`. Best-effort: a missing main process is fine.
     */
    watch(target: { sessionId?: string; path: string }): void
  }

  // -------------------------------------------------------------------------
  // Cluster D: persistent transfer queue
  // -------------------------------------------------------------------------
  /**
   * Persistent transfer queue. Items survive restarts; in-flight items are
   * marked canceled with reason "interrupted by restart" on next launch
   * (we never try to resume bytes mid-flight). `progress` is a per-item live
   * stream; `status` is the full list (subscribed via `onStatus`, the same
   * shape every other namespace uses).
   */
  transfers: {
    list(): Promise<TransferListResult>
    /**
     * Enqueue a single upload. The main process allocates the id, persists
     * the item, and starts it through the producer/consumer queue.
     */
    enqueueUpload(opts: {
      sessionId: string
      localPath: string
      remotePath: string
    }): Promise<TransferItemV2>
    enqueueDownload(opts: {
      sessionId: string
      localPath: string
      remotePath: string
    }): Promise<TransferItemV2>
    /** Mark a queued or running transfer as canceled. */
    cancel(id: string): Promise<void>
    /**
     * Re-enqueue a previously failed/canceled item. The path pair is
     * preserved; the item gets a new id and is pushed to the back of the
     * queue. Items that were interrupted by a restart are retryable too.
     */
    retry(id: string): Promise<TransferItemV2 | null>
    /** Drop all items that are done, canceled, or errored out of the list. */
    clearFinished(): Promise<TransferListResult>
    /**
     * Subscribe to live progress + done events for a single transfer.
     * The main process throttles to 250ms. Pair with the unsubscribe.
     */
    onProgress(id: string, cb: (e: TransferEvent) => void): () => void
    /**
     * Subscribe to the full queue state (list + add/remove ticks). The
     * callback fires immediately with the current snapshot, then again
     * whenever any item is added, removed, or changes state.
     */
    onStatus(cb: (items: TransferListResult) => void): () => void
  }

  // -------------------------------------------------------------------------
  // Cluster D: in-app browser pane enhancements
  // -------------------------------------------------------------------------
  browserDownloads: {
    list(): Promise<BrowserDownloadItem[]>
    cancel(id: string): Promise<void>
    onUpdate(cb: (items: BrowserDownloadItem[]) => void): () => void
  }
  browserZoom: {
    get(origin: string): Promise<number>
    set(origin: string, level: number): Promise<void>
    reset(): Promise<void>
  }
  /** Open detached DevTools for a <webview> guest identified by webContents id. */
  openBrowserDevtools(webContentsId: number): Promise<void>
  /** Mute / unmute a <webview> guest identified by webContents id. */
  setBrowserMuted(webContentsId: number, muted: boolean): Promise<void>
  /** Open a URL in the system browser after a scheme safety check. */
  openExternal(url: string): Promise<void>

  /** Global terminal search (live + history). */
  search: {
    query(q: string): Promise<SearchResult[]>
    seed(sessionId: string, lines: string[]): Promise<void>
  }
}

// ---------------------------------------------------------------------------
// Foundation cluster types (additive — append above the file's original tail)
// ---------------------------------------------------------------------------

/** Solid background colour for the terminal (also shown beneath an image). */
export interface TerminalBg {
  color: string
  image: string | null
  /** Darkening overlay over the image, 0 (none) .. 0.85 (heavy), for legibility. */
  dim: number
}

export type CursorStyle = 'block' | 'bar' | 'underline'
export type BellStyle = 'none' | 'visual'

/** Appearance + behavior preferences, applied to xterm options live. */
export interface TerminalPrefs {
  fontSize: number
  fontFamily: string
  lineHeight: number
  cursorStyle: CursorStyle
  cursorBlink: boolean
  scrollback: number
  copyOnSelect: boolean
  rightClickPaste: boolean
  scrollSensitivity: number
  bell: BellStyle
}

/** Auto-reconnect policy for SSH sessions (mirrors the renderer settings store). */
export interface AutoReconnectPrefs {
  enabled: boolean
  maxAttempts: number
  baseDelayMs: number
  maxDelayMs: number
  factor: number
}

/** A snapshot of the user's settings, suitable for export/import. */
export interface SettingsSnapshot {
  themeId: string
  terminalBg: TerminalBg
  prefs: TerminalPrefs
  autoReconnect: AutoReconnectPrefs
}

/** A persistent approval rule for the agent guardrail. */
export interface ApprovalRule {
  id: string
  /** When set, rule only applies to this session; otherwise global. */
  sessionId?: string
  /**
   * Command-prefix token. Matched at a token boundary at the end so
   * `kubectl` matches `kubectl get pods` but not `kubectlized`.
   */
  commandPrefix: string
  outcome: 'allow' | 'deny' | 'ask'
  createdAt: number
}

/** A single entry in the per-session bridge activity log. */
export type BridgeActivityKind =
  | 'tool_call'
  | 'approval_request'
  | 'approval_outcome'
  | 'transport'
  | 'agent_heartbeat'
  | 'bridge_state'

export interface BridgeActivityEntry {
  id: string
  sessionId: string
  kind: BridgeActivityKind
  /** Name of the tool/transport/agent — when applicable. */
  tool?: string
  /** Short human-readable detail line. */
  detail: string
  /** Epoch millis when the entry was recorded. */
  ts: number
  /** Optional elapsed time of the call/heartbeat in milliseconds. */
  durationMs?: number
  /** Whether the call succeeded (true) or failed (false). Undefined for non-result events. */
  ok?: boolean
}

/** SSH port-forward kind. `local` = -L, `dynamic` = -D. */
export type PortForwardKind = 'local' | 'dynamic'

export interface PortForward {
  id: string
  sessionId: string
  kind: PortForwardKind
  localPort: number
  /** Remote side; for `local` (-L): target host+port. For `dynamic` (-D): unused. */
  remoteHost?: string
  remotePort?: number
  createdAt: number
  /** Total bytes proxied since start (best-effort, may be undefined). */
  bytes?: number
}

/** Status badge for a tab (reconnecting, error, etc.). */
export type TabStatus = 'normal' | 'reconnecting' | 'disconnected' | 'agent_pending' | 'error'

/** A single recent host the user quick-connected to (for autocomplete). */
export interface QuickConnectEntry {
  host: string
  port: number
  username: string
  lastUsedAt: number
}

/** A more self-contained transfer row (used by persistence / queue UIs). */
export interface TransferItemV2 {
  id: string
  direction: 'upload' | 'download'
  sessionId: string
  localPath: string
  remotePath: string
  total: number
  transferred: number
  done: boolean
  error?: string
  canceled?: boolean
  enqueuedAt: number
  finishedAt?: number
}

/** Versioned bundle for export/import. `version: 1`. */
export interface SettingsExportBundle {
  version: 1
  exportedAt: number
  settings: SettingsSnapshot
  snippets: Snippet[]
  /** Saved connections with secret fields stripped (see settingsIo.exportAll). */
  connections: SavedConnection[]
  workspaces: Workspace[]
  approvalRules: ApprovalRule[]
}

// ---------------------------------------------------------------------------
// Git awareness (read-only) — populates the file tree with status badges and
// the "Show changes only" filter. Mutations (add/commit/push/etc.) are not
// exposed; the agent and the editor are the only writers in DevTerm.
// ---------------------------------------------------------------------------

/** Per-file git status. `?` = untracked, `U` = conflicted, `R` = renamed. */
export type GitFileStatus = 'M' | 'A' | 'D' | '?' | 'R' | 'U'

export interface GitStatus {
  /** False if the path is not inside a working tree. */
  isRepo: boolean
  /** Current branch (short, e.g. "main"); empty when detached or not a repo. */
  branch: string
  /** Commits ahead of upstream; -1 if unknown / no upstream. */
  ahead: number
  /** Commits behind upstream; -1 if unknown / no upstream. */
  behind: number
  /** Repo-relative path → file status. Only includes changed paths. */
  entries: Record<string, GitFileStatus>
  /** True when the file count was capped at the safety limit. */
  truncated?: boolean
}

// ---------------------------------------------------------------------------
// Cluster D: persistent transfer queue + in-app browser enhancements
// (additive — appended below the original tail)
// ---------------------------------------------------------------------------

/** Live status update for a single in-flight transfer item (mirrors TransferItemV2). */
export type TransferEvent =
  | { kind: 'progress'; id: string; transferred: number; total: number; done: boolean }
  | {
      kind: 'done'
      id: string
      transferred: number
      total: number
      canceled?: boolean
      error?: string
      finishedAt: number
    }

/** What the user gets back from `transfers.list()`. */
export type TransferListResult = TransferItemV2[]

/** A single in-app browser download, sourced from the persistent partition's webContents. */
export type BrowserDownloadState = 'progressing' | 'completed' | 'cancelled' | 'interrupted'

export interface BrowserDownloadItem {
  /** Electron-assigned id from the `will-download` event. */
  id: string
  /** Filename (basename) as Electron reported it. */
  filename: string
  /** Original URL the download was triggered from. */
  url: string
  /** Local path the bytes are being written to. */
  path: string
  /** Bytes received so far. */
  received: number
  /** Total bytes (Electron's `getReceivedBytes`/`getTotalBytes`). -1 if unknown. */
  total: number
  state: BrowserDownloadState
  /** Millis since epoch when first observed. */
  startedAt: number
  /** Optional MIME type. */
  mime?: string
}

/** Per-origin zoom level (1 = 100%, 1.5 = 150%). */
export interface BrowserZoomMap {
  [origin: string]: number
}

// ---------------------------------------------------------------------------
// Global Terminal Search (MVP)
// ---------------------------------------------------------------------------

export interface SearchResult {
  sessionId: string
  sessionTitle: string
  lineNumber: number
  text: string
  timestamp?: string
  kind: 'live' | 'history' | 'detached'
}
