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
  /**
   * Optional renderer session id this PTY backs. When present, the main
   * process keys the global search index (and its cleanup on exit/kill) by
   * this id instead of the raw PTY id, so search hits match the session the
   * renderer jumps to.
   */
  sessionId?: string
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
  /** Absolute working directory the PTY was spawned in (for early explorer seed). */
  cwd: string
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
  /**
   * Auto-launch this workspace on app startup (one shot per session, no
   * throttling). When multiple workspaces have this set, all of them open
   * in their own groups in the order returned by `workspaces.list()`.
   */
  autoLaunch?: boolean
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
// Agent bridge: an interactive coding agent wired to the in-process MCP
// bridge. DevTerm provides a bundled multi-provider runtime plus external CLI
// fallbacks selected per session. The MCP bridge, tools, and policy are agent-agnostic —
// they speak MCP. The renderer-visible contract below is the only place the
// agent's identity leaks out, and the IPC channel names are pure strings with
// no agent-specific bits.
// ---------------------------------------------------------------------------

export type PolicyMode = 'read_only' | 'confirm' | 'full'

/**
 * Which coding agent to spawn for a session. `devterm` runs the provider-
 * agnostic agent runtime bundled with DevTerm; it supports OAuth subscriptions,
 * API keys, and custom/local providers. `claude` runs the Claude CLI
 * (Anthropic-only, native MCP via --mcp-config); `pi` runs the pi coding agent
 * (more models/subscriptions, MCP via a loaded extension); `opencode` runs the
 * OpenCode TUI (sst/opencode) wired to the bridge through a per-session
 * `opencode.json` with a remote MCP server entry; `kimi` runs the Kimi Code CLI
 * (Moonshot AI) wired through a per-session `.kimi-code/mcp.json`; `grok` runs
 * the Grok CLI wired to the bridge through a per-session `.grok/config.toml`
 * HTTP MCP entry; `codex` runs the OpenAI Codex CLI wired through a per-session
 * isolated `CODEX_HOME/config.toml` HTTP MCP entry; `antigravity` runs the Google
 * Antigravity CLI (agy) wired through a per-session `.antigravity/mcp.json` HTTP MCP
 * entry. Every agent reaches this host only through DevTerm's MCP bridge.
 */
export type AgentKind =
  | 'devterm'
  | 'claude'
  | 'pi'
  | 'opencode'
  | 'kimi'
  | 'grok'
  | 'codex'
  | 'antigravity'

export interface AgentTrustedSkill {
  name: string
  path: string
  sha256: string
  enabled: boolean
}

export interface AgentPreferences {
  /** Optional provider id. Empty lets the runtime choose its configured default. */
  provider: string
  /** Optional model id or provider/model pair. Empty uses the provider default. */
  model: string
  /** Ordered provider/model pairs used after retryable provider failures. */
  fallbackModels: string[]
  /** Persist one conversation per remote session and reopen it after reconnects. */
  resumeSessions: boolean
  /** Hash-pinned, instruction-only skills. Executable third-party extensions stay disabled. */
  trustedSkills: AgentTrustedSkill[]
}

export interface AgentModelInfo {
  provider: string
  model: string
  context: string
  maxOutput: string
  thinking: boolean
  images: boolean
}

export interface AgentProviderStatus {
  provider: string
  authenticated: boolean
  source?: 'oauth' | 'api-key' | 'environment' | 'profile'
}

export interface AgentCapabilities {
  runtimeVersion: string
  models: AgentModelInfo[]
  providers: AgentProviderStatus[]
  loadedAt: number
}

/**
 * Where the agent terminal UI is shown for a remote session.
 * Process lifetime is independent: the agent can keep running while hidden.
 * - `docked` — side column next to the shell in the main window
 * - `floating` — separate OS window (multi-monitor)
 * - `hidden` — no visible agent terminal; process + bridge stay up
 */
export type AgentUiMode = 'docked' | 'floating' | 'hidden'

export interface AgentOpenOpts {
  sessionId: string
  /** Which agent CLI to launch. */
  kind: AgentKind
  /**
   * MCP tool policy. Omitted defaults to `full` (no DevTerm confirm modal).
   * Permission prompts belong to the agent CLI; Settings approval rules still
   * apply as an MCP pre-check.
   */
  mode?: PolicyMode
  /** Tell the agent the host has no internet. Optional; defaults to false. */
  airGapped?: boolean
  /** Built-in DevTerm Agent launch preferences. Ignored by external fallbacks. */
  preferences?: AgentPreferences
  /**
   * The remote shell's current working directory at launch (from OSC 7), so the
   * agent's commands start where the operator is. Live updates flow over
   * `agent:set-cwd`. Optional: omitted until the shell reports a cwd.
   */
  cwd?: string
  cols: number
  rows: number
  /**
   * When true, tear down any existing agent for this session and launch fresh
   * (Restart button). Default false: an already-running agent is reattached
   * so UI mode changes (dock / float / hide) do not kill the process.
   */
  forceRestart?: boolean
  /**
   * First user message for a brand-new DevTerm Agent / Pi process (`pi "…"`).
   * Ignored on reuse. Other CLIs still receive the prompt via PTY inject.
   */
  initialPrompt?: string
}

export interface SSHOpenShellOptions {
  /**
   * Legacy: when true and no `tmuxSession` is set, POSIX remotes may offer
   * a tmux session picker (renderer). Reconnect uses `tmuxSession` instead.
   */
  detached?: boolean
  /** Re-attach this named tmux session after the login shell opens (no `exec`). */
  tmuxSession?: string
}

/** One row from `tmux list-sessions` on a remote POSIX host. */
export interface TmuxSessionInfo {
  name: string
  windows: number
  /** How many clients are currently attached. */
  attached: number
  /** Unix epoch seconds, when tmux reported it. */
  created?: number
  /** Unix epoch seconds of last pane activity. */
  activity?: number
  /** Active window name. */
  currentWindow?: string
  /** Foreground process in the active pane. */
  currentCommand?: string
  /** Working directory of the active pane. */
  currentPath?: string
  /** Window labels such as `0:vim*` (star = active). */
  windowList?: string[]
  /** Visible active-pane contents, ANSI-stripped, for the picker preview. */
  preview?: string
}

/** Result of probing tmux on a live SSH session (exec channel, not the shell). */
export interface TmuxListing {
  available: boolean
  version?: string
  sessions: TmuxSessionInfo[]
  error?: string
}

/** Attach to an existing/new tmux session, or stay in the login shell. */
export interface TmuxAttachRequest {
  /** Omit / empty to stay in a normal (non-tmux) shell. */
  name?: string
  /** Create the session if it does not exist, then attach. */
  create?: boolean
}

export interface ProcessPerformanceMetric {
  type: string
  pid: number
  cpuPercent: number
  workingSetMb: number
  peakWorkingSetMb: number
}

export interface PerformanceSnapshot {
  capturedAt: number
  uptimeMs: number
  mainHeapUsedMb: number
  mainHeapTotalMb: number
  processes: ProcessPerformanceMetric[]
}

/** Result of a manual "Check for updates" request from Settings. */
export type AppUpdateStatus = 'up-to-date' | 'available' | 'downloaded' | 'disabled' | 'error'

export interface AppUpdateCheckResult {
  status: AppUpdateStatus
  currentVersion: string
  latestVersion?: string
  message: string
}

export interface AgentOpenResult {
  /** PTY id of the spawned interactive agent (use the pty.* channels). */
  ptyId: string
  mcpUrl: string
  /** True when an existing agent was reused (no relaunch). */
  reused?: boolean
}

/** Snapshot of a running agent session (attach UI without relaunching). */
export interface AgentSessionStatus {
  ptyId: string
  kind: AgentKind
  mode: PolicyMode
  bridge: AgentBridgeStatus
  /** UI placement last reported by the renderer. */
  uiMode?: AgentUiMode
}

/** Open or focus a floating agent BrowserWindow. */
export interface AgentWindowOpenOpts {
  sessionId: string
  kind: AgentKind
  mode: PolicyMode
  /** Window title suffix (hostname / session title). */
  title?: string
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
// Speech-to-text dictation (renderer-only: Web Worker + Web Audio, no IPC)
// ---------------------------------------------------------------------------

/**
 * Whisper model variant to download and run locally via Transformers.js.
 * `tiny` < `base` < `small` in size/accuracy. `base` (~140MB) is the default —
 * a good CPU/GPU tradeoff. Maps to the `Xenova/whisper-<id>` HF repo.
 */
export type STTModelId = 'tiny' | 'base' | 'small'

/**
 * ONNX Runtime backend chosen at worker boot. `wasm` runs everywhere (CPU);
 * `webgpu` is preferred when available (much faster, especially for `small`).
 */
export type STTBackend = 'webgpu' | 'wasm'

/** Language hint passed to Whisper. `auto` lets Whisper detect the language. */
export type STTLanguage =
  | 'auto'
  | 'en'
  | 'es'
  | 'fr'
  | 'de'
  | 'it'
  | 'pt'
  | 'nl'
  | 'ru'
  | 'zh'
  | 'ja'
  | 'ko'
  | 'ar'
  | 'hi'

export interface STTSettings {
  /** Master switch. When off, the toolbar mic button is hidden and the hotkey is a no-op. */
  enabled: boolean
  /** Which Whisper variant to download and use. */
  modelId: STTModelId
  /** Language hint; passed to the pipeline's `language` option unless `auto`. */
  language: STTLanguage
  /** Append a single trailing space after the transcript so the next token isn't glued to it. */
  appendSpace: boolean
  /** Show the floating status pill (independent of the toolbar; visible in zen mode). */
  showFloatingStatus: boolean
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
  sshListTmux: 'ssh:listTmux',
  sshAttachTmux: 'ssh:attachTmux',
  sshKillTmux: 'ssh:killTmux',

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

  // transfers (legacy non-persistent TransferManager channels — retired; the
  //   persistent queue now uses `transfers:enqueue*` / `transfers:event` below)

  // agent bridge (interactive `pi` wired to the in-process MCP bridge)
  agentOpen: 'agent:open',
  agentClose: 'agent:close',
  agentConfirm: 'agent:confirm', // main -> renderer
  agentConfirmReply: 'agent:confirm:reply', // renderer -> main
  /** Broadcast when a confirm is answered so other windows drop the request. */
  agentConfirmResolved: 'agent:confirm:resolved',
  agentBridgeStatus: 'agent:bridge-status', // suffixed :<sessionId>
  agentStatus: 'agent:status',
  agentSetCwd: 'agent:set-cwd', // renderer -> main: live working-directory updates
  agentCapabilities: 'agent:capabilities',
  agentChooseSkill: 'agent:choose-skill',
  /** Renderer reports docked | floating | hidden for confirm routing + windows. */
  agentSetUiMode: 'agent:set-ui-mode',
  /**
   * Main → all renderers: UI mode changed (so the main window store stays in
   * sync when a floating agent window docks/hides itself).
   */
  agentUiModeChanged: 'agent:ui-mode-changed',
  /** Open / focus a floating agent OS window. */
  agentWindowOpen: 'agent:window:open',
  /** Close the floating agent window without stopping the agent process. */
  agentWindowClose: 'agent:window:close',
  /** Main → renderer: floating window was closed by the user (X button). */
  agentWindowClosed: 'agent:window:closed',

  // Local-only process telemetry (no analytics or network reporting).
  performanceSnapshot: 'performance:snapshot',

  // App version + manual update check (GitHub releases via electron-updater)
  appGetVersion: 'app:get-version',
  appCheckForUpdates: 'app:check-for-updates',

  // saved connections (persisted in userData)
  connectionsList: 'connections:list',
  connectionsSave: 'connections:save',
  connectionsDelete: 'connections:delete',
  /** Import Host entries from the user's OpenSSH config (~/.ssh/config). */
  connectionsImportSshConfig: 'connections:import-ssh-config',

  // session restore snapshot (last-session layout; no secrets)
  sessionRestoreLoad: 'session-restore:load',
  sessionRestoreSave: 'session-restore:save',
  sessionRestoreClear: 'session-restore:clear',

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
  bridgeActivityExport: 'bridge-activity:export',
  bridgeActivityEvent: 'bridge-activity:event', // suffixed :<sessionId>

  // foundation cluster: settings export/import
  settingsIoExport: 'settings-io:export',
  settingsIoImport: 'settings-io:import',
  /**
   * Renderer → main: push the live `AppSettings` snapshot so `userData/settings.json`
   * stays in sync with the renderer's `localStorage` store. The export bundle
   * then reads the real file (not hardcoded defaults) and the import flow
   * re-applies the same snapshot to the renderer via `settings:imported`.
   */
  settingsSync: 'settings:sync',
  settingsImported: 'settings:imported',

  // foundation cluster: approval rules (action-style single channel)
  approvalRules: 'approval-rules',

  // foundation cluster: known hosts (TOFU store) — list + remove
  knownHostsList: 'known-hosts:list',
  knownHostsRemove: 'known-hosts:remove',

  // foundation cluster: QuickConnect recent hosts (autocomplete seed)
  quickConnectList: 'quick-connect:list',
  quickConnectRecord: 'quick-connect:record',

  // foundation cluster: port forwards (local -L and dynamic -D SOCKS5)
  portForwardList: 'port-forward:list',
  portForwardAdd: 'port-forward:add',
  portForwardRemove: 'port-forward:remove',

  // git status (read-only) — local and remote (mirrored over the session's exec channel)
  gitStatus: 'git:status',
  gitDiff: 'git:diff',
  gitOnChange: 'git:on-change', // suffixed :<l:/r: cache key> (see cacheKey in ipc/git.ts)
  // Fire-and-forget watch registration (ipcRenderer.send → ipcMain.on).
  gitOnChangeAdd: 'git:on-change:add',
  gitOnChangeRemove: 'git:on-change:remove',

  // git read-side: branches, remotes, log, stash, tags, contributors
  gitBranches: 'git:branches',
  gitRemotes: 'git:remotes',
  gitLog: 'git:log',
  gitStash: 'git:stash',
  gitTags: 'git:tags',
  gitFileAt: 'git:file-at',
  gitBlame: 'git:blame',
  gitShow: 'git:show',
  gitFullDiff: 'git:full-diff',
  gitContributors: 'git:contributors',

  // git write-side: checkout / branch / fetch / pull / push / stash / commit / stage / tag
  gitCheckout: 'git:checkout',
  gitCreateBranch: 'git:create-branch',
  gitDeleteBranch: 'git:delete-branch',
  gitRenameBranch: 'git:rename-branch',
  gitFetch: 'git:fetch',
  gitPull: 'git:pull',
  gitPush: 'git:push',
  gitStashApply: 'git:stash-apply',
  gitStashDrop: 'git:stash-drop',
  gitStashPop: 'git:stash-pop',
  gitCommit: 'git:commit',
  gitStage: 'git:stage',
  gitUnstage: 'git:unstage',
  gitDiscard: 'git:discard',
  gitTagCreate: 'git:tag-create',
  gitTagDelete: 'git:tag-delete',
  gitAddRemote: 'git:add-remote',
  gitRemoveRemote: 'git:remove-remote',
  gitMerge: 'git:merge',

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
    openShell(
      sessionId: string,
      cols: number,
      rows: number,
      options?: SSHOpenShellOptions
    ): Promise<void>
    input(sessionId: string, data: string): void
    resize(sessionId: string, cols: number, rows: number): void
    disconnect(sessionId: string): void
    cancelReconnect(sessionId: string): void
    getReconnectPolicy(): Promise<ReconnectPolicy>
    setReconnectPolicy(patch: Partial<ReconnectPolicy>): Promise<ReconnectPolicy>
    onData(sessionId: string, cb: (data: string) => void): () => void
    onExit(sessionId: string, cb: () => void): () => void
    onStatus(sessionId: string, cb: (s: SSHStatus) => void): () => void
    /** Probe tmux on the remote and list existing sessions (dedicated exec). */
    listTmux(sessionId: string): Promise<TmuxListing>
    /**
     * Attach the live login shell to a tmux session without `exec`, or record
     * that the operator chose a normal shell. Detach returns to the login shell.
     */
    attachTmux(sessionId: string, req: TmuxAttachRequest): Promise<void>
    /**
     * Destroy a named tmux session on the remote via exec (not the interactive
     * shell). Idempotent if the session is already gone.
     */
    killTmux(sessionId: string, name: string): Promise<void>
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
  /**
   * Agent bridge: spawn interactive `pi` wired to the in-process MCP bridge.
   * (The legacy `transfer` namespace — the non-persistent TransferManager
   * used by the old file-browser transfers — is retired; the persistent
   * `transfers` namespace below replaces it. The IPC channel constants
   * for the legacy channel names are kept as no-op strings so any
   * out-of-tree tool that referenced them still resolves.)
   */
  agent: {
    open(opts: AgentOpenOpts): Promise<AgentOpenResult>
    capabilities(forceRefresh?: boolean): Promise<AgentCapabilities>
    chooseSkill(): Promise<AgentTrustedSkill | null>
    close(sessionId: string): void
    /** Push the remote shell's live cwd so the agent's commands follow the operator's `cd`. */
    setCwd(sessionId: string, cwd: string): void
    status(sessionId: string): Promise<AgentSessionStatus | null>
    onBridgeStatus(sessionId: string, cb: (status: AgentBridgeStatus) => void): () => void
    onConfirm(cb: (req: ConfirmRequest) => void): () => void
    /** Fired when any window answers a confirm so peer windows can dismiss. */
    onConfirmResolved(cb: (info: { reqId: string; sessionId: string }) => void): () => void
    replyConfirm(reqId: string, approved: boolean): void
    /** Report UI placement so main can route approvals and manage pop-out windows. */
    setUiMode(sessionId: string, mode: AgentUiMode | null): void
    /** Open or focus the floating agent window for this session. */
    openWindow(opts: AgentWindowOpenOpts): Promise<void>
    /** Close the floating window only (agent process keeps running). */
    closeWindow(sessionId: string): void
    /** Main window: floating agent window closed by the user. */
    onWindowClosed(cb: (sessionId: string) => void): () => void
    /** Cross-window UI mode sync (floating window → main store). */
    onUiModeChanged(cb: (info: { sessionId: string; mode: AgentUiMode | null }) => void): () => void
  }
  performance: {
    snapshot(): Promise<PerformanceSnapshot>
  }
  /** App version and manual update check (packaged builds only). */
  app: {
    getVersion(): Promise<string>
    checkForUpdates(): Promise<AppUpdateCheckResult>
  }
  /** Persisted SSH connections (CRUD); each call returns the full updated list. */
  connections: {
    list(): Promise<SavedConnection[]>
    save(conn: SavedConnection): Promise<SavedConnection[]>
    delete(id: string): Promise<SavedConnection[]>
    /**
     * Parse `~/.ssh/config` (or optional path) and merge concrete Host entries
     * into saved connections. Skips wildcards and hosts that already exist
     * (same host:port:user). Does not import passwords.
     */
    importSshConfig(opts?: { path?: string }): Promise<SshConfigImportResult>
  }
  /** Last-session restore snapshot (groups + local/remote items + layout). */
  sessionRestore: {
    load(): Promise<SessionRestoreSnapshot | null>
    save(snap: SessionRestoreSnapshot): Promise<void>
    clear(): Promise<void>
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
    /**
     * Export every entry for a session (in-memory ring + on-disk tail,
     * merged and ts-sorted) to a JSONL file at `targetPath`. Returns the
     * number of lines written. Pops a native save dialog if `targetPath`
     * is omitted.
     */
    export(sessionId: string, targetPath?: string): Promise<number | null>
  }
  /**
   * Settings export/import. Pops a native save/open dialog; the bundle is
   * versioned (see `SettingsExportBundle`) and secrets are stripped on export.
   * `sync` pushes the live renderer snapshot to the main process so the
   * on-disk `userData/settings.json` stays in sync; `onImported` fires after
   * a successful import with the (merged-with-defaults) snapshot the
   * renderer should apply to its local store.
   */
  settingsIo: {
    export(): Promise<string | null>
    import(): Promise<{
      ok: boolean
      error?: string
      counts?: { settings: boolean; snippets: number; workspaces: number; approvalRules: number }
    }>
    sync(snapshot: SettingsSnapshot): void
    onImported(cb: (snapshot: SettingsSnapshot | null) => void): () => void
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
   * SSH known-hosts (TOFU) store. `list` returns every trusted host with its
   * sha256 fingerprint; `remove` forgets one — the next connect re-triggers
   * the `hostkey-new` status so the operator can re-accept the key.
   */
  knownHosts: {
    list(): Promise<{ hostId: string; fingerprint: string }[]>
    remove(hostId: string): Promise<void>
  }
  /**
   * QuickConnect: most-recently-used `host:port:user` triples for the
   * connection form's host autocomplete. No secrets — just the target.
   * Capped at 20 entries, deduped by `host|port|user`.
   */
  quickConnect: {
    list(): Promise<QuickConnectEntry[]>
    record(host: string, port: number, username: string): Promise<void>
  }
  /**
   * SSH port forwarding. `list`/`add`/`remove` cover both local `-L`
   * forwards (`PortForwardManager` opens a `net.Server` on `127.0.0.1` and
   * pipes through the session's ssh2 `forwardOut`) and dynamic `-D` SOCKS5
   * forwards (no-auth, CONNECT only — see `port-forward.ts`).
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
   *
   * Warp-style git panel additions: branches, remotes, log, stash, tags, file
   * history, blame, full diff, contributors, and a write-side surface
   * (checkout, commit, stage/unstage, fetch/pull/push, stash apply/drop/pop,
   * branch create/delete/rename, tag create/delete, remote add/remove, merge).
   * All write operations accept `sessionId?: string` so they apply to local or
   * remote (over the session's existing exec channel — never a new SSH
   * connection) and return a structured result so the UI can show the git
   * command's exit code + stderr cleanly.
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

    // ---- read-side additions ------------------------------------------------

    /** List local + remote branches with HEAD pointers. */
    branches(target: { sessionId?: string; path: string }): Promise<GitBranches>
    /** List git remotes with URLs. */
    remotes(target: { sessionId?: string; path: string }): Promise<GitRemote[]>
    /** Show the commit log (newest first) for the current HEAD. */
    log(target: {
      sessionId?: string
      path: string
      maxCount?: number
      /** Optional ref to start from (default HEAD). */
      ref?: string
      /** Optional path filter (repo-relative). */
      file?: string
    }): Promise<GitLogEntry[]>
    /** List stashes (most recent first). */
    stash(target: { sessionId?: string; path: string }): Promise<GitStashEntry[]>
    /** List tags (lightweight + annotated) with their target OIDs. */
    tags(target: { sessionId?: string; path: string }): Promise<GitTag[]>
    /** Show the contents of a file at a given ref (HEAD by default). */
    fileAt(target: {
      sessionId?: string
      path: string
      file: string
      ref?: string
    }): Promise<string>
    /** Blame for a file: per-line author + sha + line text. */
    blame(target: { sessionId?: string; path: string; file: string }): Promise<GitBlameLine[]>
    /** Show one commit (message + stat). */
    show(target: {
      sessionId?: string
      path: string
      sha: string
    }): Promise<GitShowResult | null | undefined>
    /** Full working-tree diff (all tracked changes) as a single patch. */
    fullDiff(target: {
      sessionId?: string
      path: string
      /** Restrict to one file (repo-relative). */
      file?: string
      /** Restrict to staged changes (`git diff --cached`). */
      staged?: boolean
    }): Promise<string>
    /** Aggregated contributors ranked by commit count. */
    contributors(target: {
      sessionId?: string
      path: string
      maxCount?: number
    }): Promise<GitContributor[]>

    // ---- write-side mutations ----------------------------------------------

    /**
     * Switch the working tree to `target` — a branch name, remote ref
     * (`origin/main`), tag, or commit SHA. When `create` is true the branch is
     * created first (analogous to `git checkout -b`). When `force` is true
     * a dirty working tree is still swapped (analogous to `git checkout -f`).
     */
    checkout(target: {
      sessionId?: string
      path: string
      target: string
      create?: boolean
      force?: boolean
    }): Promise<GitCommandResult>
    /** Create a new branch without switching (analogous to `git branch <name>`). */
    createBranch(target: {
      sessionId?: string
      path: string
      name: string
      /** Branch off this ref instead of HEAD. */
      from?: string
      /** When true, the new branch is set to track `from` (e.g. a remote). */
      track?: boolean
      /** Overwrite an existing branch (only valid when `from` differs). */
      force?: boolean
    }): Promise<GitCommandResult>
    /** Delete one or more branches (uses `git branch -d`; pass `force` for `-D`). */
    deleteBranch(target: {
      sessionId?: string
      path: string
      names: string[]
      force?: boolean
    }): Promise<GitCommandResult>
    /** Rename the current branch (or `oldName` if provided). */
    renameBranch(target: {
      sessionId?: string
      path: string
      oldName?: string
      newName: string
      force?: boolean
    }): Promise<GitCommandResult>
    /** Fetch from a remote (default `origin`). Pass `prune: true` for `git fetch --prune`. */
    fetch(target: {
      sessionId?: string
      path: string
      remote?: string
      prune?: boolean
    }): Promise<GitCommandResult>
    /** Pull from `remote`/`branch`. Pass `rebase: true` for `git pull --rebase`. */
    pull(target: {
      sessionId?: string
      path: string
      remote?: string
      branch?: string
      rebase?: boolean
    }): Promise<GitCommandResult>
    /** Push to `remote`/`branch`. `setUpstream` adds `-u`. `force` is `git push --force-with-lease`. */
    push(target: {
      sessionId?: string
      path: string
      remote?: string
      branch?: string
      setUpstream?: boolean
      force?: boolean
    }): Promise<GitCommandResult>
    /** Apply a stash without dropping it (`git stash apply <ref>`). */
    stashApply(target: {
      sessionId?: string
      path: string
      ref?: string
    }): Promise<GitCommandResult>
    /** Drop a stash (`git stash drop <ref>`). */
    stashDrop(target: { sessionId?: string; path: string; ref?: string }): Promise<GitCommandResult>
    /** Pop the top of the stash (or `ref` if given). */
    stashPop(target: { sessionId?: string; path: string; ref?: string }): Promise<GitCommandResult>
    /** Create a commit. `files` stages the given paths before committing; omit to commit staged. */
    commit(target: {
      sessionId?: string
      path: string
      message: string
      files?: string[]
      amend?: boolean
      signOff?: boolean
    }): Promise<GitCommandResult>
    /** Stage one or more paths (analogous to `git add <path>…`; paths are repo-relative). */
    stage(target: { sessionId?: string; path: string; files: string[] }): Promise<GitCommandResult>
    /** Unstage one or more paths (analogous to `git restore --staged <path>…`). */
    unstage(target: {
      sessionId?: string
      path: string
      files: string[]
    }): Promise<GitCommandResult>
    /** Discard working-tree changes to one or more paths (analogous to `git restore <path>…`). */
    discard(target: {
      sessionId?: string
      path: string
      files: string[]
    }): Promise<GitCommandResult>
    /** Create a tag at HEAD (or `ref` if provided). Annotated when `message` is set. */
    tagCreate(target: {
      sessionId?: string
      path: string
      name: string
      ref?: string
      message?: string
      force?: boolean
    }): Promise<GitCommandResult>
    /** Delete one or more tags (local). */
    tagDelete(target: {
      sessionId?: string
      path: string
      names: string[]
    }): Promise<GitCommandResult>
    /** Add a remote (`git remote add`). */
    addRemote(target: {
      sessionId?: string
      path: string
      name: string
      url: string
    }): Promise<GitCommandResult>
    /** Remove a remote (`git remote remove`). */
    removeRemote(target: {
      sessionId?: string
      path: string
      name: string
    }): Promise<GitCommandResult>
    /** Merge `target` into the current branch (`git merge --no-ff` optional). */
    merge(target: {
      sessionId?: string
      path: string
      target: string
      noFastForward?: boolean
      message?: string
    }): Promise<GitCommandResult>
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

/** A snapshot of the user's settings, suitable for export/import.
 *
 * Mirrors the full renderer `AppSettings` shape. Fields are optional so a
 * bundle written by an older DevTerm (with only the core 4 fields) still
 * validates; the reader fills missing fields from the same defaults the
 * renderer uses. The renderer's settings store is the canonical live copy
 * (in `localStorage`); this snapshot is the on-disk round-trip used by
 * `settings-io` for export/import and by the `settings:sync` IPC for keeping
 * `userData/settings.json` up to date.
 */
export interface SettingsSnapshot {
  themeId?: string
  terminalBg?: TerminalBg
  prefs?: TerminalPrefs
  autoReconnect?: AutoReconnectPrefs
  attention?: AttentionSettingsSnapshot
  showStatusBar?: boolean
  agentActivityCollapsed?: boolean
  inactivePaneDimming?: boolean
  sftpSidePane?: boolean
  activityIndicators?: boolean
  zenMode?: boolean
  agentKind?: AgentKind
  agentPreferences?: AgentPreferences
  /** Offer a tmux session picker when connecting to a POSIX host that has tmux. */
  remoteDetachedSessions?: boolean
  /**
   * On next app start, reopen the last session snapshot (local shells + saved
   * SSH connections + split layout). Auto-launch workspaces still take priority.
   */
  sessionRestore?: boolean
  transfersPanelOpen?: boolean
  defaultShell?: DefaultShellPref
  gitPanelOpen?: boolean
  /** Per-id keybinding overrides. */
  keybindings?: Record<string, { mod?: boolean; shift?: boolean; alt?: boolean; key: string }>
  stt?: STTSettings
  /** Optional persistent global-search tail (off by default). */
  searchPersist?: boolean
}

// ---------------------------------------------------------------------------
// Session restore (last-session snapshot) + SSH config import
// ---------------------------------------------------------------------------

/** One capturable terminal in a session-restore group. */
export interface SessionRestoreItem {
  id: string
  kind: 'local' | 'remote'
  /** Remote items: saved connection id (required to reconnect). */
  connectionId?: string
  cwd?: string
  title?: string
}

export interface SessionRestoreGroup {
  /** Display name for the group tab. */
  name: string
  items: SessionRestoreItem[]
  /** Layout leaf tabs reference item ids. */
  layout?: WorkspaceLayoutNode | null
}

/**
 * Snapshot of open groups written to `userData/session-restore.json`.
 * No secrets — remotes only store connectionIds.
 */
export interface SessionRestoreSnapshot {
  version: 1
  savedAt: number
  groups: SessionRestoreGroup[]
  /** Index into `groups` that was active when saved. */
  activeGroupIndex?: number
}

/** Result of importing Host blocks from an OpenSSH config file. */
export interface SshConfigImportResult {
  /** Full updated connection list after the import. */
  connections: SavedConnection[]
  /** How many new connections were added. */
  added: number
  /** How many Host entries were skipped (wildcard, duplicate, incomplete). */
  skipped: number
  /** Absolute path that was read. */
  path: string
  /** Non-fatal parse/read note when the file was missing or empty. */
  message?: string
}

/** Attention settings (mirrors the renderer `AttentionSettings`). */
export interface AttentionSettingsSnapshot {
  enabled?: boolean
  sound?: boolean
  volume?: number
  system?: boolean
  idle?: boolean
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
// Git status (file-tree badges + "Show changes only" filter). Full read/write
// git ops live further below (Git panel / Warp-style UI) — this block is only
// the compact status shape shared with the explorer.
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
// Git read-side + write-side (Warp-style panel)
// ---------------------------------------------------------------------------

/** A single branch reference returned by `git.branches()`. */
export interface GitBranch {
  /** Short branch name, e.g. "main". */
  name: string
  /** Resolved commit SHA (HEAD of the branch). */
  sha: string
  /** True for the currently checked-out branch. */
  current: boolean
  /** Upstream tracking ref (e.g. "origin/main") or null when not set. */
  upstream: string | null
  /** True for remote-tracking refs (prefixed "origin/"). */
  remote: boolean
  /** Commits ahead of upstream; -1 when no upstream. */
  ahead: number
  /** Commits behind upstream; -1 when no upstream. */
  behind: number
}

/** Result of `git.branches()`. */
export interface GitBranches {
  /** All branches, including remotes; `current` flag identifies HEAD. */
  branches: GitBranch[]
  /** Best-effort default branch (e.g. "origin/main" or "main"). */
  defaultBranch: string | null
}

/** A single git remote (result of `git remotes -v`). */
export interface GitRemote {
  /** Remote name (e.g. "origin"). */
  name: string
  /** Fetch URL (may be empty for push-only remotes). */
  fetchUrl: string
  /** Push URL (often identical to fetch URL). */
  pushUrl: string
}

/** A single commit in `git log` output. */
export interface GitLogEntry {
  /** Full commit SHA. */
  sha: string
  /** Short SHA (first 7 chars). */
  shortSha: string
  /** Commit subject (first line). */
  subject: string
  /** Full commit body (everything after the first blank line). */
  body: string
  /** Author name. */
  authorName: string
  /** Author email. */
  authorEmail: string
  /** Committer name (often same as author on local commits). */
  committerName: string
  /** Committer email. */
  committerEmail: string
  /** ISO 8601 author timestamp. */
  authorDate: string
  /** ISO 8601 committer timestamp. */
  committerDate: string
  /** First parent (preceding commit) or null for the root. */
  parent: string | null
  /** Total parents (≥2 for merge commits). */
  parentCount: number
  /** All parent SHAs in order. Length matches `parentCount`; the first entry
   *  equals `parent`. Source of truth for the graph layout pass. */
  parents: string[]
  /** Refs (branches/tags) that point at this commit, e.g. ["origin/main", "HEAD"]. */
  refs: string[]
}

/** A single stash entry (`git stash list`). */
export interface GitStashEntry {
  /** Full stash ref, e.g. "stash@{0}". */
  ref: string
  /** Stash message (e.g. "WIP on main: abcdef1 …"). */
  message: string
  /** SHA the stash was created from. */
  sha: string
  /** Branch the stash was created on, when known. */
  branch: string | null
  /** Unix-millis when the stash was created. */
  date: number
}

/** A single tag. */
export interface GitTag {
  /** Tag name. */
  name: string
  /** SHA the tag points at. */
  sha: string
  /** Tag message (empty for lightweight tags). */
  message: string
  /** Tagger name (annotated only). */
  taggerName: string
  /** Tagger email (annotated only). */
  taggerEmail: string
  /** ISO 8601 tag date (annotated only). */
  date: string
  /** True for annotated tags. */
  annotated: boolean
}

/** One line of `git blame` output. */
export interface GitBlameLine {
  /** 1-based line number. */
  line: number
  /** Commit SHA the line was last changed in. */
  sha: string
  /** Short SHA. */
  shortSha: string
  /** Author name. */
  author: string
  /** ISO 8601 author date. */
  date: string
  /** Line content (no trailing newline). */
  text: string
}

/** Result of `git show <sha>`. */
export interface GitShowResult {
  sha: string
  shortSha: string
  subject: string
  body: string
  authorName: string
  authorEmail: string
  authorDate: string
  /** Files changed with stats. */
  files: Array<{
    /** Repo-relative path. */
    path: string
    /** Status: "M" / "A" / "D" / "R" / "C". */
    status: string
    /** Additions in this file. */
    additions: number
    /** Deletions in this file. */
    deletions: number
  }>
  /** The raw patch for this commit. */
  patch: string
}

/** Aggregated author statistics (`git shortlog -sn`). */
export interface GitContributor {
  name: string
  email: string
  commits: number
}

/**
 * Generic result envelope for write-side git operations. Most callers only
 * care about `ok`; the others let the UI show git's own stderr so the user
 * can debug failures (auth, conflicts, pre-commit hook rejects, etc.).
 */
export interface GitCommandResult {
  /** True when `code === 0`. */
  ok: boolean
  /** Exit code (null on timeout). */
  code: number | null
  /** Captured stdout (often empty for mutation commands). */
  stdout: string
  /** Captured stderr (may include hints from git itself). */
  stderr: string
  /** True when the command exceeded its timeout. */
  timedOut: boolean
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
