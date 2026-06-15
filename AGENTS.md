# AGENTS.md

This file guides Codex and other coding agents when working in the DevTerm repository.

DevTerm is an Electron 29 desktop terminal for local shells, SSH/SFTP sessions, terminal workspaces, file browsing and editing, an in-app browser, saved command snippets, and an embedded **Claude** (or **Pi**) coding agent bridge. It is built with electron-vite, TypeScript strict mode, React 18, Zustand, xterm.js, ssh2, CodeMirror 6, and a prebuilt node-pty native module. The agents run as real interactive CLIs in a local node-pty and operate on the connected remote host through an in-process MCP bridge the app hosts itself.

## Product Shape

DevTerm is a normal framed desktop application so Windows owns the titlebar, resize border, Snap Layouts, edge snapping, minimize/maximize/close controls, and system menu. The first screen is the working terminal interface, not a marketing page. The in-app top toolbar hosts the app brand, the top-level view switcher, settings, and keyboard shortcuts.

The top-level views are:

- **Terminals**: the always-mounted terminal workspace. It contains group tabs, split panes, pane tabs, local shells, remote SSH terminals, browser panes, editor overlays, an in-app Claude/Pi agent pane, a bridge activity panel, and a transfer queue panel.
- **Connections**: saved SSH connection management. Users create, edit, connect, and delete saved connection profiles. Secrets are encrypted with Electron `safeStorage` when available.
- **Workspaces**: saved terminal groups. Users launch saved sets of terminals and split layouts into their own group. Workspaces support rename, duplicate, launch counting, and live terminal capture from a group.
- **Snippets**: saved command snippets. Users manage commands that can be sent to the active terminal directly or through the command palette. Snippets may contain `{{placeholder}}` tokens.

A unified bottom-dock pattern holds two optional panels that the toolbar's "Activity | Transfers | Off" segmented control toggles between:

- **Agent Activity panel** — per-session timeline of MCP bridge events (tool calls, approval requests, outcomes, bridge state transitions).
- **Transfers panel** — the persistent transfer queue (uploads/downloads with progress, cancel, retry).

A bottom status bar shows the active session's kind, cwd, git branch (with ahead/behind counters) for local sessions, and SSH latency with exponential backoff for remote sessions.

Terminal panes can host:

- A local shell (`kind: 'local'`).
- A remote SSH shell (`kind: 'remote'`).
- An in-app browser pane (`kind: 'browser'`).

Remote SSH panes can also open:

- A file browser/SFTP view.
- A Claude or Pi agent side pane connected to the remote host through DevTerm's MCP bridge.
## User Flows

### Startup

`src/renderer/App.tsx` mounts the app. On first load it asks the main process for local host context and opens one local terminal if no sessions exist. The Terminals view stays mounted throughout the app lifetime so local PTYs, SSH shells, browser panes, and agent panes are not destroyed by view navigation. The bottom status bar and the transfers / activity panels are also part of the always-mounted subtree.

The main process:

- Pins Chromium's disk cache, GPU shader cache, and service-worker storage into `userData` (see the file header in `src/main/index.ts`) so a zombie electron.exe or a freshly-migrated profile cannot deadlock the cache.
- Hardens every `<webview>` guest: strips preload, disables node integration, routes `target=_blank` / `window.open` to a `browser:open-tab` push so the pane can create a new tab, strips `DevTerm/x` and `Electron/x` from the persistent `browser` partition's user agent, and builds a context menu for guest pages.
- Swallows two benign errors at the process level: Electron 29's `Render frame was disposed before WebFrameMain could be accessed` (webview guests tearing down mid-navigation) and `EPIPE` from a node-pty/ConPTY whose conin pipe just closed.

### Opening Terminals

New terminals are opened from `NewTerminalModal.tsx`. Users open it by pressing the pane tab strip plus button, double-clicking empty tab-strip space, using the global new-terminal hotkey, or clicking an empty-state call to action. The picker offers:

- Local shell: `useSessions.addLocal()` creates an in-memory session. `TerminalView` mounts xterm and asks main IPC to create a local PTY.
- SSH connection: `ConnectionForm` or `ConnectionsManager` calls `useSessions.connectSsh()`. The main process creates one ssh2 client for the session, detects host context, and later opens a shell channel for xterm. The session store shows transient `reconnecting… / reconnected / reconnect cancelled / reconnect failed` status strings surfaced by `SSHStatus`.
- Browser pane: `useSessions.addBrowser()` creates a browser session. `TerminalLayout` routes it to `BrowserPane`, which hosts Electron `<webview>` tabs.

### Terminal Layout And Groups

The tiling model lives in `src/renderer/store/layout.ts`. A layout is a binary split tree:

- `leaf` nodes hold pane tabs and an active session id.
- `split` nodes divide children horizontally (`row`) or vertically (`col`) with fractional sizes. The store clamps resize deltas to a `0.18` floor so a pane can't be collapsed into a sliver.
- `groups` hold independent split trees. The default group is `default`; launched workspaces and user-created groups get their own group ids. `groupFlags` flags a group as launched from a workspace so the chrome can offer "Save changes back".

`TerminalLayout.tsx` computes absolute rectangles from the active group's tree. It renders one stable `.term-slot` per session in a terminal layer and renders pane chrome in a separate layer. Sessions from inactive groups stay mounted but hidden. This is intentional: reparenting or unmounting xterm destroys PTYs and SSH shells.

Users can:

- Drag pane tabs to another pane's center to stack them as tabs.
- Drag pane tabs to a pane edge to create a split.
- Drag pane tabs onto group tabs to move sessions between groups.
- Drag pane tabs onto the new-group target to spin a session into its own group.
- Drag split handles to resize panes.
- Merge a pane back into another pane.

Pane sizing must preserve usable windows. Split minimums, nested split spans, visible pane edges, and split handle styling are there to keep one pane from collapsing another into an unusable sliver.

### Focus Mode

Focus mode magnifies the active session without reparenting it. It is controlled by `focusedId` in `store/layout.ts` and entered by Ctrl/Cmd+Shift+Z, the per-pane focus button, or pane UI. Esc, backdrop click, or the floating close button exits focus mode.

`TerminalLayout` repositions the focused `.term-slot` with fixed insets and a raised z-index. Pane chrome is hidden while focused. The terminal's existing ResizeObserver refits xterm to the new size. Animations must not scale xterm because scaled terminal text blurs.

### Local Terminal Flow

`TerminalView.tsx` creates an xterm instance and loads the canvas renderer, Fit, Search, and WebLinks addons. **The renderer uses xterm's canvas addon, not WebGL** — see `src/renderer/lib/renderer.ts` for the rationale (Chromium caps live WebGL contexts and evicts the oldest when the mount-everything layout exceeds the cap, blanking out panes; canvas has no per-context cap).

For local sessions `TerminalView` calls `window.devterm.pty.create()`. Data returns over the coalesced `pty:data:<id>` channel (4ms burst coalescing; see `src/main/ipc/coalesce.ts`). Exit events return over `pty:exit:<id>`. Input is captured through one custom key handler that also matches `HOTKEYS` and returns false for matched hotkeys so the keystroke is NOT sent to the shell.

`PtyManager` chooses a default shell, preferring PowerShell on Windows, and injects a PowerShell prompt function that emits OSC 7 (directory) and OSC 133 (semantic prompt) markers. Explicit shell args, such as the `pi` CLI launch, bypass prompt injection. The OSC 133 `;B` marker is used by the history-driven inline autosuggest in `lib/autosuggest.ts`.

### Remote SSH Flow

Saved and ad-hoc SSH sessions go through:

- Renderer store: `src/renderer/store/sessions.ts`.
- IPC: `src/main/ipc/ssh.ts` (data is also coalesced).
- Manager: `src/main/ssh/manager.ts` (20k+ LOC, owns the ssh2 client, shell, SFTP, exec, watch, and auto-reconnect).
- Connection setup: `src/main/ssh/connection.ts`.
- OS detection: `src/main/ssh/osDetect.ts`.

Each remote session owns one ssh2 client. The interactive shell, SFTP channel, exec channels, directory watch polling, agent tools, and SSH port forwards all reuse that same client. Do not create a second SSH connection for features bound to an existing session.

Host keys are trust-on-first-use through `knownHosts.ts` and stored in Electron `userData`, not `~/.ssh`. Host key mismatches are rejected.

Remote SSH dials its own TCP socket with `setNoDelay(true)` before handing it to ssh2. Keep that path intact; without TCP_NODELAY interactive SSH feels laggy.

Remote POSIX shells receive a small OSC 7 hook (`__dt7`) after shell open so the renderer can track the current working directory. Windows PowerShell remotes are detected with a one-shot `echo $PSVersionTable` probe (5s timeout, cached per session); cmd.exe does not support OSC 7 and is left to `$HOME` defaults. Preserve the OSC 7 behavior when editing shell setup.

#### Auto-reconnect

`SSHManager` runs an exponential-backoff auto-reconnect loop (configurable in the Settings modal):

- Master switch, max attempts, initial delay, max delay cap, and backoff factor.
- Status events: `reconnecting { attempt, maxAttempts, delayMs }`, `reconnected { attempt }`, `reconnect-failed { attempts, reason }`.
- The renderer subscribes to `sshStatus:<id>` and shows a reconnect banner with a Cancel button (which calls `ssh:cancel-reconnect`). The agent pane and the bridge status pill both reflect these state transitions.
### Files, SFTP, And Editing

The left `FileExplorer` follows the active shell working directory. Local sessions browse local filesystem IPC; remote sessions browse through SFTP on the active SSH session. Browser panes show a no-files placeholder.

The explorer is a tree with inline expansion, multi-select, drag-and-drop transfer support, fuzzy `/` search, and a read-only git status overlay (branch pill, ahead/behind counters, file-level badges, and a "Show changes only" filter) — see `src/main/git.ts` and `src/main/ipc/git.ts`. The git status IPC is read-only, with a 5s poll loop that pushes only on signature change.

`SftpBrowser.tsx` provides dual local/remote panes for transfers with multi-select and drag-and-drop. `FilePane`, `FileExplorer`, and `FileTree` share the `FsApi` abstraction in `src/renderer/lib/fsapi.ts`.

Directory listings live-update:

- Local watch: `src/main/fs/watch.ts`, using `fs.watch` plus a safety poll.
- Remote watch: `src/main/ssh/watch.ts`, using SFTP polling because SFTP has no inotify.
- Renderer subscriptions: `FsApi.watch()`.

Avoid manual refresh patterns for new listing views. Use `FsApi.watch()` and let main diff directory signatures.

File editing uses CodeMirror 6 in `EditorView.tsx` with `basicSetup`, `oneDark`, and a per-extension language pack from `lib/cm-languages.ts`. The editor has a "Run in terminal" button that pipes the current selection (or full doc) to the active terminal through the existing input pipeline. The Run language picker is cosmetic — it chooses the trailing line terminator (`
` for sh/bash/python/node/sql, `` for ps1) — and is not persisted.

File contents cross IPC as UTF-8 text with size and mtime metadata. Large files are limited by `MAX_EDIT_BYTES` in `src/shared/types.ts`. Original EOL style is preserved on save; CRLF is normalized to LF in memory and re-applied on write.

### Transfers (persistent queue)

`src/main/transfers/queue.ts` + `store.ts` implement a persistent, persistent-across-restart transfer queue backed by `userData/transfers.json`. The queue is a producer/consumer with hard concurrency 2, 250ms renderer throttling, and a `cancelers` map so an in-flight transfer can be aborted by destroying the read/write streams.

- In-flight items at the time of the last crash are durably marked `canceled: true, error: 'interrupted by restart'` on next launch — bytes are never resumed mid-flight.
- The renderer subscribes through `useTransfersSync` (mounted once in `App.tsx`) and `useTransfers` (Zustand) for live progress; `TransfersPanel` is the bottom-docked UI.
- Items are retryable; multi-select upload/download on the SFTP browser enqueues one item per file. The `enqueueUpload` / `enqueueDownload` channels throw if the `sessionId` is unknown.

### Port forwards

`src/main/ssh/port-forward.ts` provides local (`-L`) port forwarding on the existing ssh2 client. Each accept opens a fresh `forwardOut` channel on the SAME client (channel-mux; never a second `new Client()`) and pipes the local socket to that channel. Bytes are counted both ways and exposed via the `portForward.list` IPC.

Dynamic (`-D` SOCKS) forwards are explicitly out of scope: `addAsync` rejects with a clear error so the UI can show the limitation.

### Browser Pane Flow

`BrowserPane.tsx` hosts Electron `<webview>` tabs with the persistent partition `persist:browser`. Main process hardens guests in `src/main/index.ts` (see Startup). Browser panes are sessions, so they participate in groups, tabs, splitting, and focus mode but do not create PTYs or SSH channels.

The browser pane supports:

- Tab strip, address bar (URL-or-search box), back/forward/reload.
- Per-tab zoom (Ctrl+Plus/Minus/0) with a per-origin persisted map in `userData/browser-zoom.json` (clamped to `[0.5, 3.0]`; same-origin broadcast on change).
- Per-tab mute (`webContents.setAudioMuted`).
- Find bar with `n / m` match count, `found-in-page` driven, Next/Previous steppers.
- Detached DevTools (Ctrl+Shift+I), per `openBrowserDevtools(webContentsId)`.
- Download drawer: a `will-download` hook on the persistent partition captures every download, exposes a list/cancel IPC, and writes to `userData/Downloads/` by default.
### Snippets And Command Palette

Snippets are persisted in `userData/snippets.json` through `src/main/ipc/snippets.ts`. Renderer helpers live in `src/renderer/lib/snippets.ts`. The command palette (`CommandPalette.tsx`) filters snippets and sends commands to the active terminal through `lib/input.ts`.

Snippets can contain `{{placeholders}}`. Parameterized snippets prompt before running. The recent-values cache for placeholders lives in `sessionStorage` only (TTL 5 min, scoped to `(snippetId, placeholderName)`) and is intentionally NOT persisted to disk — placeholder values often contain host names, usernames, and other identifying strings.

The palette also exposes a frecency-ranked command history. History comes from two merged sources (`src/main/ipc/history.ts`):

- Commands the user RAN through DevTerm, recorded in `userData/history.json` (2000-entry cap, scoped `local` vs `remote`).
- The host's own shell-history files: PSReadLine (`%APPDATA%\Microsoft\PowerShell\PSReadLine\ConsoleHost_history.txt` for PowerShell 7 and `\Microsoft\Windows\PowerShell\PSReadLine\…` for Windows PowerShell 5.1), `~/.bash_history`, and `~/.zsh_history` (zsh timestamp prefix stripped). Remote history is read over the session's existing SSH exec channel (never a second connection) with an 8s timeout.

Both sources pass through a `looksSensitive` filter (passwords, tokens, AKIA keys, `gh*_` / `github_pat_` tokens, PEM private-key headers) so credentials never reach the store or the palette. The frecency blend is `score = 0.6 * (1 / (ageDays + 1)) + 0.4 * log10(count + 1)` over a max 60/12 cap.

### Workspaces

Workspaces are persisted in `userData/workspaces.json`. A workspace stores:

- `items`: local or remote terminal descriptors, saved connection ids, optional cwd, and title.
- `layout`: a split snapshot whose leaf tabs reference workspace item ids, not live session ids.
- `lastLaunchedAt` + `launchCount`: bumped on every launch (incremental IPC `workspaces:record-launch`).
- `description` (optional free-form).

Workspace management is full CRUD + `workspaces:rename` (single-field patch) + `workspaces:duplicate` (new ids with " (copy)" suffix, layout leaves remapped to the new item ids). Pre-1.0.1 remote-only workspaces carrying the legacy `connectionIds` field are migrated on load into the current `items` model.

Capture starts in the Terminals view through the group bar's Save group action (`SaveWorkspaceModal.tsx`). `renderer/lib/workspace.ts` builds the snapshot from the active group. Launching a workspace creates a new group, opens each terminal, maps workspace item ids to live session ids, and restores the split tree. A group launched from a workspace is flagged via `groupFlags[groupId] = { launchedFromWorkspaceId }` so the chrome can offer "Save changes back".

Ad-hoc SSH sessions without a saved `connectionId` are skipped during capture because DevTerm cannot reconnect them later without credentials. Browser panes are excluded by design.
### Agent Bridge (Claude and Pi)

The embedded agents are real interactive CLI processes spawned in a local node-pty — they are never invoked with `-p` (Claude), the SDK, or any API-key path. The launch flow is:

- Renderer: `RemoteSessionView.tsx` opens `AgentPane.tsx` beside a remote terminal. The user picks `Claude` or `Pi` per session; the choice persists in `useSettings.agentKind`.
- IPC: `src/main/ipc/agent.ts`.
- Launch prep:
  - `src/main/agent/claude-launch.ts` for Claude — writes a per-session `CLAUDE.md` and an `--mcp-config` JSON pointing at `127.0.0.1:<port>` with a `Bearer <token>` header. Spawns `claude` with `--mcp-config <path> --strict-mcp-config --permission-mode bypassPermissions --dangerously-skip-permissions --allowedTools 'mcp__devterm__*,Read,Write,Edit'`. The agent's built-in `Read`/`Write`/`Edit` tools are intentionally scoped to the agent's local scratch dir; the briefing steers all host work through `mcp__devterm__*`.
  - `src/main/agent/launch.ts` for Pi — writes `AGENTS.md` + the per-session pi extension, picks the `pi` binary (Windows prefers `.cmd`/`.bat`/`.exe` shim to dodge the POSIX-shim `ERROR_BAD_EXE_FORMAT` 193), spawns with `--no-session --no-builtin-tools -e <abs-path>/devterm-mcp.mjs --offline`.
- Agent instructions: `src/main/agent/context.ts` — `buildAgentsMd` for Pi, `buildClaudeMd` for Claude. Both include a `## Working directory` section pointing at the live cwd (pushed over `agent:set-cwd`) and an air-gapped mode that forbids internet installs.
- pi extension source: `src/main/agent/extension.ts` — a TypeScript string the launch step writes to disk and pi loads via `-e`. Persists the MCP `sessionId` to a sidecar JSON so the extension can rejoin after `/reload` (the bridge rejects a second `initialize`).
- MCP bridge: `src/main/mcp/server.ts` (transport-agnostic).
- Tools: `src/main/mcp/tools.ts`.
- Policy: `src/main/mcp/policy.ts`.

For each agent session DevTerm:

1. Starts an in-process MCP server on `127.0.0.1:<random-port>` gated by a random 24-byte hex bearer token.
2. Writes a per-session working directory (under `os.tmpdir()`) containing the briefing markdown + the bridge adapter.
3. Spawns the agent CLI in a node-pty with the args above.

Built-in pi tools are intentionally disabled so the agent cannot read/write the local machine; everything the model does goes through the MCP bridge, which runs on the shared `ssh2` client for the session. The agent's terminal output is raw and must not be parsed as state. Bridge state is reported by main over `agent:bridge-status:<sessionId>` based on actual MCP HTTP activity. The UI shows `connecting, starting, listening, connected, disconnected, stopped, error, exited` states (mirrored into the session store as `agentBridgeState` for the tab dot). Recoverable states show a Restart button that recreates the bridge and agent process.

The bridge disables Node HTTP idle / request / socket timeouts and forces TCP keepalive on every connection (15s), and sends a standard MCP `notifications/message` heartbeat every 25 seconds while the agent's standalone SSE stream is connected — so a quiet agent session does not look stale to the client or OS.

#### Agent tools

`mcp__devterm__*` MCP tools (`src/main/mcp/tools.ts`):

- `ping` — bridge liveness.
- `get_host_context` — host, OS, live cwd, policy mode.
- `run_command` — runs on the host's `exec` channel. The default timeout is 5 minutes (cluster ops like `helm install` / `oc apply` routinely run well past 30s). The agent's `command` is prefixed with `cd '<cwd>' && …` for POSIX remotes where a live `cwd` is known, so commands run where the operator is `cd`'d. Windows remotes (cwd `C:\\...`) skip the prefix and fall back to the SSH login default `$HOME` — the briefing tells the agent to use absolute paths in that case.
- `list_dir`, `read_file`, `write_file` — SFTP on the same client; relative paths resolve against the live cwd.
- `write_file` always goes through `Policy.evaluateWrite()` before the actual write. Destructive or mutating operations in `confirm` mode pop a `ConfirmActionModal`; approvals/denials/5-minute snoozes are stacked FIFO and prev/next-navigable.

#### Bridge activity log

`src/main/bridge-activity.ts` keeps a 500-entry per-session ring buffer plus a `userData/bridge-activity.jsonl` tail file (rotated at 5000 lines). The renderer subscribes per-session via `useBridgeActivity(sessionId)` in `lib/bridge-activity.ts` and renders a filterable timeline (all / tools / approvals / errors) in `AgentActivityPanel.tsx`. The panel is the third row of the `RemoteSessionView`'s term-agent split, collapsed by default; collapse state is persisted in `useSettings.agentActivityCollapsed`. Recorded kinds: `tool_call`, `approval_request`, `approval_outcome`, `transport`, `agent_heartbeat`, `bridge_state`.

#### Approval rules

`src/main/approval-rules.ts` persists command-prefix approval rules to `userData/approval-rules.json` (atomic `.tmp + rename`). Rules can be session-scoped or global, with outcomes `allow` / `deny` / `ask`. The `match(sessionId, command)` helper is a longest-prefix match with token-boundary enforcement (`kubectl` matches `kubectl get pods`, not `kubectlized`). Approval rules act as a PRE-CHECK in `Policy.evaluateCommandAsync` — an explicit `allow` or `deny` rule wins over the mode-based decision; `ask` falls through to the mode.

The `ConfirmActionModal` "remember this command" option calls `approvalRules.add({ commandPrefix, outcome: 'allow' })` after a successful approval, so the next call to the same prefix skips the prompt.

#### Policy modes

DevTerm policy modes:

- `read_only`: blocks mutating commands and writes (`Policy` uses `MUTATING` / `DESTRUCTIVE` regexes to spot `rm`, `mv`, `cp`, `systemctl start`, `oc apply`, `git push`, `drop database`, etc.).
- `confirm`: asks for mutating/destructive commands and writes.
- `full`: allows commands and writes without DevTerm approval prompts (the agent still has its own permission flags).

The current UI defaults the agent to `full` / bypass mode. If a workflow needs operator prompts, switch the mode before opening the agent.

### Settings And Theme Flow

Settings live in `src/renderer/store/settings.ts` and persist to `localStorage` (no secrets). Themes live in `src/renderer/lib/themes.ts`.

One theme drives both the app chrome and xterm ANSI palette. `applyTheme()` writes CSS variables to the document root. `styles.css` derives surfaces, borders, hovers, muted colors, and accent treatments from those variables. Prefer CSS variables and `color-mix`; avoid hardcoded colors unless there is a specific reason.

Nine built-in themes ship: Tokyo Night, Dracula, Catppuccin Mocha, Nord, Gruvbox, One Dark, Solarized Dark, Ayu Mirage, and a translucent **Glass** (`data-glass` attribute enables backdrop blur; native Acrylic/Mica is opt-in via `window:set-glass` but only lights up when a future Electron build supports it on the platform).

`useSettings` carries: `themeId`, `terminalBg { color, image, dim }`, `prefs { fontSize, fontFamily, lineHeight, cursorStyle, cursorBlink, scrollback, copyOnSelect, rightClickPaste, scrollSensitivity, bell }`, `autoReconnect { enabled, maxAttempts, baseDelayMs, maxDelayMs, factor }`, `showStatusBar`, `agentActivityCollapsed`, `agentKind` (`'claude' | 'pi'`), `transfersPanelOpen`. Auto-reconnect changes are pushed live to the main process over `ssh:set-reconnectPolicy`; the persisted settings drive the live `SSHManager` policy.

#### Settings export / import

`src/main/settings-io.ts` round-trips a versioned `SettingsExportBundle` (`version: 1`) covering settings + snippets + connections + workspaces + approval rules. On export, secret fields (`password`, `passphrase`, `privateKeyPath`) are STRIPPED from every connection including nested `jump` bastions. Import always uses `mode: 'merge'` from the dialog flow (a `replace` mode is available programmatically but not in the UI) to keep an accidental overwrite from wiping saved connections.

Motion is CSS-only near the end of `styles.css`, guarded by reduced-motion media queries. Animate opacity and transform only. Do not animate xterm viewport geometry or use scale on terminal text.
### Window Management Flow

DevTerm uses a normal framed BrowserWindow. Windows owns window movement, resizing, Snap Layouts, edge snapping, maximize/restore, minimize, close, and the system menu. Do not implement custom snap buttons, custom edge snapping, or fake window controls in the renderer.

- `src/main/index.ts` creates the BrowserWindow with `frame: true` and `transparent: false`.
- `src/main/ipc/window.ts` only handles optional window material hooks such as `window:set-glass`; it must not own snapping or window-control behavior.
- `App.tsx` has an in-app toolbar, not a draggable custom titlebar.

### Auto-update

`src/main/updater.ts` wires `electron-updater` to GitHub Releases with a prompt-before-install flow. The update downloads silently in the background; the user is asked to restart now (and DevTerm runs `autoUpdater.quitAndInstall()`) or apply it on next quit. No update checks run in dev or during the headless self-test.

## Process And IPC Architecture

DevTerm has three layers:

- Main process (`src/main`): Electron windows, IPC handlers, node-pty, SSH/SFTP, filesystem, transfers, MCP bridge, persistence, auto-update.
- Preload (`src/preload/index.ts`): the only typed bridge exposed to the sandboxed renderer.
- Renderer (`src/renderer`): React UI, Zustand state, xterm, CodeMirror, browser panes.

All renderer-to-main capabilities must be represented in `src/shared/types.ts`, implemented in a main IPC handler, and exposed in preload. The renderer is sandboxed with `contextIsolation: true`, `nodeIntegration: false`, and `sandbox: true`.

### Code Map

| Area | Code |
| --- | --- |
| App entry and BrowserWindow | `src/main/index.ts` |
| IPC registration | `src/main/ipc/*` |
| Shared contracts | `src/shared/types.ts` |
| Preload API | `src/preload/index.ts` |
| Top-level app and view routing | `src/renderer/App.tsx` |
| Session store | `src/renderer/store/sessions.ts` |
| Layout store | `src/renderer/store/layout.ts` |
| Settings store | `src/renderer/store/settings.ts` |
| Editors store | `src/renderer/store/editors.ts` |
| Transfers store | `src/renderer/store/transfers.ts` |
| Local PTY manager | `src/main/pty/manager.ts` |
| SSH manager | `src/main/ssh/manager.ts` |
| SSH connection setup | `src/main/ssh/connection.ts` |
| SFTP helpers | `src/main/ssh/sftp.ts` |
| SSH port forwards | `src/main/ssh/port-forward.ts` |
| File APIs and local watch | `src/main/fs/*` |
| Persistent transfer queue | `src/main/transfers/queue.ts`, `src/main/transfers/store.ts` |
| Transfer queue UI | `src/renderer/components/TransfersPanel.tsx`, `src/renderer/lib/useTransfersSync.ts` |
| In-app browser IPC | `src/main/ipc/browser.ts` |
| Browser zoom store | `src/main/browser-zoom.ts` |
| Git status (read-only) | `src/main/git.ts`, `src/main/ipc/git.ts` |
| Command history | `src/main/ipc/history.ts`, `src/renderer/lib/history-frecency.ts` |
| Foundation IPC | `src/main/foundation-ipc.ts` |
| Bridge activity log | `src/main/bridge-activity.ts`, `src/renderer/lib/bridge-activity.ts` |
| Settings export / import | `src/main/settings-io.ts` |
| Approval rules | `src/main/approval-rules.ts` |
| Auto-update | `src/main/updater.ts` |
| Terminal layout | `src/renderer/components/TerminalLayout.tsx` |
| Terminal view | `src/renderer/components/TerminalView.tsx` |
| Remote shell/files/agent wrapper | `src/renderer/components/RemoteSessionView.tsx` |
| Agent pane | `src/renderer/components/AgentPane.tsx` |
| Agent activity panel | `src/renderer/components/AgentActivityPanel.tsx` |
| MCP bridge and tools | `src/main/mcp/server.ts`, `src/main/mcp/tools.ts`, `src/main/mcp/policy.ts` |
| Claude agent launch | `src/main/agent/claude-launch.ts` |
| Pi agent launch | `src/main/agent/launch.ts` |
| Agent briefings | `src/main/agent/context.ts` |
| Pi extension source | `src/main/agent/extension.ts` |
| Browser pane | `src/renderer/components/BrowserPane.tsx` |
| File explorer/tree | `src/renderer/components/FileExplorer.tsx`, `FileTree.tsx`, `FilePane.tsx` |
| SFTP browser | `src/renderer/components/SftpBrowser.tsx` |
| Editor | `src/renderer/components/EditorView.tsx` |
| Status bar | `src/renderer/components/StatusBar.tsx` |
| Workspaces | `src/main/ipc/workspaces.ts`, `src/renderer/lib/workspace.ts`, `WorkspacesManager.tsx`, `SaveWorkspaceModal.tsx` |
| Connections | `src/main/ipc/connections.ts`, `ConnectionForm.tsx`, `ConnectionsManager.tsx` |
| Snippets | `src/main/ipc/snippets.ts`, `SnippetsManager.tsx`, `SnippetForm.tsx` |
| Command palette and hotkeys | `CommandPalette.tsx`, `src/renderer/lib/hotkeys.ts` |
| Inline autosuggest | `src/renderer/lib/autosuggest.ts`, `src/renderer/components/Autosuggest.tsx` |
| Themes | `src/renderer/lib/themes.ts`, `src/renderer/styles.css` |
| Window appearance hook | `src/main/ipc/window.ts` |
| Dialogs (image picker) | `src/main/ipc/dialog.ts` |
| IPC coalescing | `src/main/ipc/coalesce.ts` |
| Tab status | `src/renderer/lib/tab-status.ts`, `src/renderer/components/TabStatusDot.tsx` |
| Confirm queue | `src/renderer/components/ConfirmActionModal.tsx` |
| Packaging | `electron-builder.yml`, `package.json`, `scripts/setup-native.mjs` |
## Persistence

All persistence is in Electron `userData`:

- `connections.json`: saved SSH connections, atomic writes, secret fields encrypted with Electron `safeStorage` when available (the `v1:` prefix indicates encrypted bytes; `raw:` is the safeStorage-unavailable fallback).
- `workspaces.json`: saved terminal groups and layouts, no secrets.
- `snippets.json`: saved command snippets, no secrets.
- `settings.json`: theme, terminal background, and terminal preferences, no secrets.
- `history.json`: in-app captured commands (scoped `local` vs `remote`, sensitive lines filtered).
- `approval-rules.json`: command-prefix approval rules, no secrets.
- `bridge-activity.jsonl`: per-session bridge event tail (rotated at 5000 lines, in-memory ring capped at 500).
- `transfers.json`: persistent transfer queue (in-flight items at the time of the last crash are durably marked `canceled: true, error: 'interrupted by restart'` on next launch).
- `browser-zoom.json`: per-origin zoom level for the in-app browser.
- `Downloads/`: default save location for `<webview>` downloads.

Renderer sessions, layout state, open editors, transfer-state progress overlay, and agent (Claude / Pi) processes are in-memory only.

## Commands

- `npm run setup`: first-time setup. Fetches Electron and the node-pty prebuilt. Do not run `npm rebuild` for node-pty on this machine.
- `npm run dev`: electron-vite development mode.
- `npm run typecheck`: required correctness gate for main, preload, shared, and renderer TypeScript.
- `npm run lint`: ESLint for `src`.
- `npm run format`: Prettier for source files.
- `npm run format:check`: Prettier check.
- `npm run build`: electron-vite bundle to `out/`.
- `npm run preview`: electron-vite preview.
- `npm run build:win`: bundle and build unsigned Windows NSIS x64 installer into `dist/`.
- `npm run build:linux`: bundle and build Linux AppImage.
- `npm run release:win` / `npm run release:linux`: build + publish.
- `node scripts/smoke.cjs`: quick runtime smoke test for node-pty and ssh2.
- `electron . --self-test`: headless self-test with a 90 second watchdog.

## Packaging And Release

The application version is `package.json` `version`. Version `1.0.0` builds a Windows installer named `dist/DevTerm-1.0.0-setup.exe` plus `latest.yml` and a blockmap.

Windows packaging uses `electron-builder.yml`:

- `appId: com.devterm.app`
- `productName: DevTerm`
- NSIS x64 target
- unsigned build
- `asarUnpack` for `node-pty`
- GitHub publish provider `AEmad99/devterm`

For release replacement, build locally first, then update the GitHub release/tag intentionally. Typical flow:

1. Verify: `npm run typecheck`, `npm run lint`, `node scripts/smoke.cjs`.
2. Build: `npm run build:win`.
3. Commit to `main`.
4. Push `main`.
5. Move or recreate tag `v1.0.0` if the user explicitly wants to override the existing version.
6. Upload `dist/DevTerm-1.0.0-setup.exe`, `.blockmap`, and `latest.yml` to release `v1.0.0` with clobber semantics.

## Critical Rules

- Keep terminals mounted. Hide with CSS; do not unmount `TerminalLayout` for top-level view changes.
- Keep xterm instances in stable DOM slots. Do not reparent terminal nodes during layout, group switching, drag/drop, or focus mode.
- Use the canvas renderer, not WebGL. Chromium caps live WebGL contexts and evicts the oldest when exceeded; the mount-everything layout regularly blows past the cap and would blank out panes.
- Keep node-pty prebuilt and `asarUnpack` intact. Do not rebuild node-pty locally.
- Add IPC capabilities through shared types, main handler, and preload exposure together.
- Use the existing SSH client for shell, SFTP, watches, exec, port forwards, and agent tools. Do not open hidden duplicate SSH connections.
- Preserve OSC 7 cwd tracking for local and remote shells (and OSC 133 prompt markers for the autosuggest).
- Use `FsApi.watch()` for live listings. Do not bring back manual refresh as a primary update path.
- Respect the MCP policy boundary in new tools. `Policy.evaluateCommandAsync` and `Policy.evaluateWrite` are the only authorized entry points; pre-check approval rules first.
- Treat agent terminal output as user-facing terminal data, not application state. Bridge state is reported by main over `agent:bridge-status:<sessionId>` based on actual MCP HTTP activity.
- Use theme CSS variables instead of hardcoded palettes.
- Keep motion out of xterm viewport and behind reduced-motion guards.
- Keep the BrowserWindow normal/framed and let Windows handle snapping; do not add custom snap controls or edge-snapping logic.
- Use the persistent transfer queue (`window.devterm.transfers.*`) for new transfer flows. Do not bring back the inline `transfer:start` / `transfer:cancel` legacy IPC.
- Agents run as real interactive CLIs only. Never pass `-p` (Claude), the SDK, or any API-key path; the user must authenticate with the CLI on their own subscription.
- Commit directly to `main` unless the user asks for a branch or PR.