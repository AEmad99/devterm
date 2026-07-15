# AGENTS.md

This file guides Codex and other coding agents when working in the DevTerm repository.

DevTerm is an Electron desktop terminal for local shells, SSH/SFTP sessions, terminal workspaces, file browsing and editing, an in-app browser, saved command snippets, a Warp-style Git panel, persistent transfer queue, offline voice dictation, global terminal search, and an embedded coding-agent bridge. It is built with Electron 29, electron-vite, TypeScript strict mode, React 18, Zustand, xterm.js (Fit/Search/WebLinks/Canvas/WebGL addons), ssh2, CodeMirror 6, marked + DOMPurify (Markdown preview), `@huggingface/transformers` (local Whisper STT), electron-updater, zod, and a prebuilt node-pty native module. The agent bridge can host six coding-agent CLIs — `pi` (`@earendil-works/pi-coding-agent`), `claude` (Anthropic Claude Code), `opencode` (sst/opencode), `kimi` (Moonshot Kimi Code), `grok` (Grok CLI), and `codex` (OpenAI Codex CLI); all six run as real interactive CLIs in a local node-pty and reach the remote host only through DevTerm's in-process MCP bridge.

## Product Shape

DevTerm is a normal framed desktop application so Windows owns the titlebar, resize border, Snap Layouts, edge snapping, minimize/maximize/close controls, and system menu. The first screen is the working terminal interface, not a marketing page. The in-app top toolbar hosts the app brand, the local host badge, the top-level view switcher, the Git panel toggle, the bottom-panel segmented control (Activity / Transfers / Off), the dictation mic button, and the settings/shortcuts buttons.

The top-level views are:

- **Terminals**: the always-mounted terminal workspace. It contains group tabs, split panes, pane tabs, local shells, remote SSH terminals, browser panes, terminal grids, editor overlays, and agent panes.
- **Connections**: saved SSH connection management. Users create, edit, connect, and delete saved connection profiles.
- **Workspaces**: saved terminal groups. Users launch saved sets of terminals and split layouts into their own group, and rename/duplicate/re-launch them.
- **Snippets**: saved command snippets. Users manage commands that can be sent to the active terminal directly or through the command palette.

Terminal panes can host:

- A local shell (`kind: 'local'`).
- A remote SSH shell (`kind: 'remote'`).
- An in-app browser pane (`kind: 'browser'`).

Remote SSH panes can also open:

- A file browser/SFTP view (full-pane or side pane).
- A coding-agent side pane (claude/pi/opencode/kimi/grok/codex) connected to the remote host through DevTerm's MCP bridge.
- An SSH port-forward panel (local `-L` forwards; dynamic `-D` is stubbed).

## User Flows

### Startup

`src/renderer/App.tsx` mounts the app. On first load it asks the main process for local host context, opens one local terminal if no sessions exist, and pushes the saved SSH auto-reconnect policy to the main process. A window `focus` listener clears the active session's needs-attention badge whenever the operator returns to DevTerm. The Terminals view stays mounted throughout the app lifetime so local PTYs, SSH shells, browser panes, and agent panes are not destroyed by view navigation — switching away hides it via `.term-hidden` (visibility:hidden + off-screen translate, never `display:none`) so terminals keep their real dimensions and xterm pauses their render loops while backgrounded.

### Opening Terminals

New terminals are opened from `NewTerminalModal.tsx`. Users open it by pressing the pane tab strip plus button, double-clicking empty tab-strip space, using the global new-terminal hotkey, or clicking an empty-state call to action. The picker offers:

- Local shell: `useSessions.addLocal()` creates an in-memory session. `TerminalView` mounts xterm and asks main IPC to create a local PTY.
- SSH connection: `ConnectionForm` or `ConnectionsManager` calls `useSessions.connectSsh()`. The main process creates one ssh2 client for the session, detects host context, and later opens a shell channel for xterm.
- Browser pane: `useSessions.addBrowser()` creates a browser session. `TerminalLayout` routes it to `BrowserPane`, which hosts Electron `<webview>` tabs.
- Terminal grid: `CreateGridModal.tsx` creates an N×M grid (max 4×4 / 16 cells) of local shells in a new group via `lib/createGrid.ts`, with optional broadcast command sent to every cell.

The command palette's Actions category also offers "Create terminal grid…". `duplicateTerminal` reopens the active session (local with same cwd, or remote via its saved connection).

### Terminal Layout And Groups

The tiling model lives in `src/renderer/store/layout.ts`. A layout is a binary split tree:

- `leaf` nodes hold pane tabs and an active session id.
- `split` nodes divide children horizontally (`row`) or vertically (`col`) with fractional sizes.
- `groups` hold independent split trees. The default group is `default`; launched workspaces and user-created groups get their own group ids.

`TerminalLayout.tsx` computes absolute rectangles from the active group's tree. It renders one stable `.term-slot` per session in a terminal layer and renders pane chrome in a separate layer. Sessions from inactive groups stay mounted but hidden. This is intentional: reparenting or unmounting xterm destroys PTYs and SSH shells.

Users can:

- Drag pane tabs to another pane's center to stack them as tabs.
- Drag pane tabs to a pane edge to create a split.
- Drag pane tabs onto group tabs to move sessions between groups.
- Drag pane tabs onto the new-group target to spin a session into its own group.
- Drag split handles to resize panes (minimum 0.18 per pane).
- Merge a pane back into another pane.

Pane sizing must preserve usable windows. Split minimums, nested split spans, visible pane edges, and split handle styling are there to keep one pane from collapsing another into an unusable sliver. Grid creation (`lib/grid.ts`) builds a row-major snapshot and restores it through the same `restoreGroup` path.

`groupFlags` (in-memory) tags a group as launched from a workspace (`launchedFromWorkspaceId`); the group bar then offers "Save back" to overwrite the originating workspace with the current live arrangement.

### Focus Mode

Focus mode magnifies the active session without reparenting it. It is controlled by `focusedId` in `store/layout.ts` and entered by Ctrl/Cmd+Shift+Z, the per-pane focus button, or pane UI. Esc, backdrop click, or the floating close button exits focus mode. It is also cleared on group switch and when the focused session closes.

`TerminalLayout` repositions the focused `.term-slot` with fixed insets and a raised z-index. Pane chrome is hidden while focused. The terminal's existing ResizeObserver refits xterm to the new size. Animations must not scale xterm because scaled terminal text blurs.

### Zen Mode

Zen mode (`zenMode` in `store/settings.ts`, toggled by Ctrl/Cmd+Alt+Z) hides the top toolbar, group bar, file sidebar, and status bar for a minimal single-pane layout. The dictation floating status pill deliberately stays visible so mic feedback survives zen mode. An "Exit zen mode" button is rendered when zen is on.

### Local Terminal Flow

`TerminalView.tsx` creates an xterm instance and loads Fit, Search, WebLinks, Canvas, and WebGl addons. For local sessions it calls:

- `window.devterm.pty.create()` through preload.
- `src/main/ipc/pty.ts`.
- `src/main/pty/manager.ts`.

`PtyManager` chooses a default shell from the user's `defaultShell` preference (`auto` prefers PowerShell 7, then Windows PowerShell 5.1, then cmd.exe on Windows; `$SHELL` on POSIX; `pwsh`/`powershell`/`cmd`/`custom` overrides) and injects a PowerShell prompt function that emits OSC 7 directory updates and OSC 133 prompt markers. Explicit shell args, such as an agent CLI launch, bypass prompt injection.

Terminal data returns over `pty:data:<id>`. Exit events return over `pty:exit:<id>`. If a fresh PTY exits without ever producing data, `pty:startup-failure:<id>` fires with a `PtyStartupFailure` (the classic Windows PowerShell 5.1 managed-signature `0x8009001d` failure); `TerminalView` renders a targeted diagnostic suggesting PowerShell 7 or a different default shell instead of the generic exit notice. Local PTY data chunks are also pushed into the in-memory global search index.

### Remote SSH Flow

Saved and ad-hoc SSH sessions go through:

- Renderer store: `src/renderer/store/sessions.ts`.
- IPC: `src/main/ipc/ssh.ts`.
- Manager: `src/main/ssh/manager.ts`.
- Connection setup: `src/main/ssh/connection.ts`.
- OS detection: `src/main/ssh/osDetect.ts`.
- Port forwarding: `src/main/ssh/port-forward.ts`.

Each remote session owns one ssh2 client. The interactive shell, SFTP channel, exec channels, directory watch polling, port forwards, git remote ops, and agent tools all reuse that same client. Do not create a second SSH connection for features bound to an existing session.

Direct hops dial their own TCP socket with `setNoDelay(true)` before handing it to ssh2; keep that path intact (without TCP_NODELAY interactive SSH feels laggy). A single bastion/ProxyJump hop is supported via `profile.jump`: the bastion is connected first, then `forwardOut` tunnels the second hop through it. The bastion client is held for the session lifetime.

Host keys are trust-on-first-use through `knownHosts.ts` and stored in `userData/known_hosts.json` (not `~/.ssh`), mode `0o600`. First-use emits a `hostkey-new` status; mismatches emit `hostkey-mismatch` and are rejected.

Auto-reconnect is fully implemented. `ReconnectPolicy` (`enabled`, `maxAttempts` default 5, `baseDelayMs` 1000, `maxDelayMs` 30000, `factor` 2 for exponential backoff) is pushed from the renderer settings and applied live. On drop the manager fires `closed`, then schedules `reconnecting` (with attempt/delay), `reconnected`, or `reconnect-failed` statuses over `ssh:status:<id>`. A sentinel placeholder keeps the session id stable across reconnects. `cancelReconnect` and a manual "Reconnect now" entrypoint exist. The agent bridge subscribes via `addStatusListener` so it can pause tools and surface "retry shortly" instead of crashing on a drop.

Remote POSIX shells receive an OSC 7 hook (`__dt7`) and OSC 133 prompt markers (`__dtA`/`__dtB`) after shell open (idempotent wraps of `PROMPT_COMMAND`/`PROMPT`/`precmd_functions` for bash/zsh) so the renderer can track the current working directory and prompt anchors. Windows remotes probe `echo $PSVersionTable` once (cached per session) and inject a PowerShell `prompt` function emitting OSC 133 A / OSC 7 / OSC 133 B; cmd.exe has no OSC 7 support and is a known limitation. All setup writes go through `setupTimers`, cleared on disconnect. Preserve the OSC 7/133 behavior when editing shell setup.

`exec` runs a one-shot command over a dedicated exec channel on the existing client (default 30s timeout, 120s for network git ops); on timeout it resolves with `timedOut: true` plus partial output — the command keeps running on the host and the client is untouched, so a timeout is not a disconnect. `getSftp` lazily opens and caches an SFTP channel on the existing client.

Port forwarding: local `-L` forwards are implemented in `port-forward.ts` (`net.Server` on `127.0.0.1` piped through `client.forwardOut`, with byte counters). Dynamic `-D` SOCKS forwards run a minimal SOCKS5 server (no-auth, CONNECT only) — each client request is parsed and tunneled through its own `forwardOut` channel. The `PortForwardPanel.tsx` UI lists/adds/removes forwards (local and dynamic) and polls bytes every 2s. (The stale header comment in `foundation-ipc.ts` claiming add/remove are stubs is wrong.)

### Files, SFTP, And Editing

The left `FileExplorer` follows the active shell working directory. Local sessions browse local filesystem IPC; remote sessions browse through SFTP on the active SSH session. Browser panes show a no-files placeholder.

`SftpBrowser.tsx` provides dual local/remote panes for transfers. `FilePane`, `FileExplorer`, and `FileTree` share the `FsApi` abstraction in `src/renderer/lib/fsapi.ts`. `FileMutationDialog.tsx` handles rename/new-file/mkdir/delete. The `sftpSidePane` setting opens Files docked beside the terminal (resizable, 280–900px) instead of replacing the shell view; the shell layer stays mounted hidden so dimensions survive.

Directory listings live-update:

- Local watch: `src/main/fs/watch.ts`, using `fs.watch` plus a safety poll.
- Remote watch: `src/main/ssh/watch.ts`, using SFTP polling (2500ms) because SFTP has no inotify.
- Renderer subscriptions: `FsApi.watch()`.

Avoid manual refresh patterns for new listing views. Use `FsApi.watch()` and let main diff directory signatures.

File editing uses CodeMirror 6 in `EditorView.tsx` (`lib/cm-languages.ts` picks the language extension). File contents cross IPC as UTF-8 text with size, mtime, and EOL metadata. Large files are limited by `MAX_EDIT_BYTES` (5 MiB) in `src/shared/types.ts`. The editor re-applies the original EOL on save. Markdown files (`.md`/`.markdown`/`.mdown`/`.mkd`) get a sanitized live preview (`lib/markdown-preview.ts`: marked GFM + DOMPurify, allowlisted tags/attrs, https/mailto/# hrefs only, disabled checkboxes) with edit/side/preview modes. "Run in terminal" pipes the selection (or whole doc) to the active terminal, inferring EOL per language.

### Browser Pane Flow

`BrowserPane.tsx` hosts Electron `<webview>` tabs with the persistent partition `persist:browser` (logins/cookies persist across tabs/panes/restarts). Tabs stay mounted with display toggled so pages/scroll survive. Main process hardens guests in `src/main/index.ts` and `src/main/ipc/browser.ts`:

- `will-attach-webview` strips any preload and forces `nodeIntegration: false`.
- Popup handling sends `browser:open-tab` to the renderer so the pane can create a tab; the native popup is denied.
- Guests are restricted to `http(s)://` and `about:blank`; other navigations/redirects are sent to the OS browser (safe schemes only).
- A right-click context menu provides Back/Forward/Reload/Cut/Copy/Paste/Select All/Copy Link/Open in system browser.
- The browser partition strips `DevTerm/x` and `Electron/x` from the user agent so sign-in flows don't flag the webview as unsafe.
- Sensitive permissions (camera/mic/geolocation/notifications/USB/serial/HID) are default-denied; only `fullscreen` and `clipboard-sanitized-write` are allowed.

Browser pane features: per-tab mute, address bar (doubles as Google search), back/forward/reload/home, per-origin zoom (persisted in `userData/browser-zoom.json`, clamped 0.5–3.0, applied on navigation), find-in-page (`/`), a downloads drawer (live progress + cancel, tracked via `will-download` into `userData/Downloads`), detached DevTools, and open-in-system-browser. Browser panes are sessions, so they participate in groups, tabs, splitting, and focus mode but do not create PTYs or SSH channels.

### Snippets, History, And Command Palette

Snippets are persisted in `userData/snippets.json` through `src/main/ipc/snippets.ts`. Renderer helpers live in `src/renderer/lib/snippets.ts`. Snippets can contain `{{placeholders}}`; parameterized snippets prompt before running, with a sessionStorage cache (5-min TTL) of recent values. Plain snippets can run directly into the active terminal.

Command history is merged from commands run through DevTerm (recorded over `history:record`) and the host's own shell-history files (PSReadLine locally; `~/.bash_history`/`~/.zsh_history` remotely, read over the session's exec channel). `history:query` returns recent-first and most-used-first lists per scope (local/remote).

The command palette (`CommandPalette.tsx`) has categories All / Actions / Snippets / Connections / Workspaces / History, fuzzy-matched via `lib/fuzzy.ts` and frecency-ranked (`lib/history-frecency.ts`). Snippets run directly or open a placeholder form (Insert with Shift+Enter, Run with Enter). Connections connect; Workspaces launch; History items show run counts and can be promoted to a snippet; Actions offers "Create terminal grid…". Commands are sent to the active terminal through `lib/input.ts`.

### Workspaces

Workspaces are persisted in `userData/workspaces.json`. A workspace stores:

- `items`: local or remote terminal descriptors, saved connection ids, optional cwd, and title.
- `layout`: a split snapshot whose leaf tabs reference workspace item ids, not live session ids.
- `description`, `lastLaunchedAt`, and `launchCount` (bumped by `workspaces:record-launch`).

Capture starts in the Terminals view through the group bar's Save group action. `renderer/lib/workspace.ts` builds the snapshot from the active group. Launching a workspace creates a new group, opens each terminal, maps workspace item ids to live session ids, restores the split tree, records the launch, and flags the group with `launchedFromWorkspaceId` for "Save back". Workspaces can also be renamed (`workspaces:rename`) and duplicated (`workspaces:duplicate`, " (copy)" suffix).

Ad-hoc SSH sessions without a saved `connectionId` are skipped during capture because DevTerm cannot reconnect them later without credentials.

### Agent Bridge (Pi / Claude / OpenCode / Kimi / Grok / Codex)

The embedded agent is a real interactive CLI process spawned in a local PTY — not the API or SDK. The bridge is agent-agnostic (it speaks standard MCP streamable HTTP); only the per-agent launch layer and tool-prefix convention differ.

- Renderer: `RemoteSessionView.tsx` opens `AgentPane.tsx` beside a remote terminal; the agent kind (persisted to `settings.agentKind`, default `claude`) and policy mode are picked per pane.
- IPC/controller: `src/main/ipc/agent.ts`.
- Launch prep: `src/main/agent/launch.ts` (pi), `claude-launch.ts`, `opencode-launch.ts`, `kimi-launch.ts`, `grok-launch.ts`, `codex-launch.ts`. Each writes the briefing + a per-agent config to a temp dir and resolves the agent's binary (preferring `.cmd`/`.exe` shims on Windows).
- Agent instructions: `src/main/agent/context.ts` (six builders, one per agent — host briefing, air-gapped rules, MCP tool map; each agent's tool-prefix convention differs).
- pi extension source: `src/main/agent/extension.ts` (a TypeScript string the launch step writes to disk as `devterm-mcp.mjs` and pi loads via `-e`).
- MCP bridge: `src/main/mcp/server.ts` (transport-agnostic `McpBridge` on `127.0.0.1:<random-port>` gated by a random 24-byte bearer token).
- Tools: `src/main/mcp/tools.ts` (`ping`, `get_host_context`, `run_command`, `list_dir`, `read_file`, `write_file`).
- Policy: `src/main/mcp/policy.ts`.

For each agent session DevTerm:

1. Starts an in-process MCP server on `127.0.0.1:<random-port>` gated by a random bearer token.
2. Writes a per-session working directory containing the briefing file and the per-agent bridge adapter/config.
3. Spawns the agent in a node-pty with the binary + args its launch layer picked:

   - **pi**: `pi --no-session --no-builtin-tools -e <abs>/devterm-mcp.mjs --offline`. Bridge URL/token travel through `DEVTERM_BRIDGE_URL` / `DEVTERM_BRIDGE_TOKEN` env vars. The extension does the MCP handshake and re-registers each tool as `mcp__devterm__<name>`. Briefing: `AGENTS.md`.
   - **claude**: `claude --mcp-config <path> --strict-mcp-config --permission-mode bypassPermissions --dangerously-skip-permissions --allowedTools mcp__devterm__* --allowedTools Read --allowedTools Write --allowedTools Edit` (each `--allowedTools` takes one rule). The `mcp-config.json` wires the bridge as a remote HTTP server with the bearer token in a header. Claude keeps its local Read/Write/Edit enabled (scoped by `--allowedTools`) for scratch, but the briefing steers all host work through `mcp__devterm__*`. Briefing: `CLAUDE.md`.
   - **opencode**: `opencode <temp-dir>` with `OPENCODE_CONFIG=<temp-dir>/opencode.json`. The config has a `mcp.devterm` remote entry, every built-in tool disabled (`bash`/`read`/`write`/`edit`/`apply_patch`/`glob`/`grep`/`lsp`/`webfetch`/`websearch`/`skill`/`todowrite`/`question` = false), `autoupdate: false`, `share: 'disabled'`, `snapshot: false`. Tool prefix is `devterm_<name>` (no `mcp__` segment). Briefing: `AGENTS.md`.
   - **kimi** (Moonshot Kimi Code): no CLI args; auto-discovers `.kimi-code/mcp.json` in cwd. Config has `mcpServers.devterm` with `url` + bearer header (no `type` field). Tool prefix `mcp__devterm__<name>`. Briefing: `AGENTS.md`.
   - **grok**: `grok --always-approve --disable-web-search --no-subagents` with `GROK_FOLDER_TRUST=0`. Writes `.grok/config.toml` (MCP server with bearer header) and `.claude/settings.json` (deny-by-default, allow `MCPTool(devterm__*)`). Tool prefix `devterm__<name>` (single underscore, no `mcp__`). Briefing: `AGENTS.md`.
   - **codex** (OpenAI Codex): args vary by policy mode (`--sandbox read-only` always; `--ask-for-approval never`/`untrusted`/`on-request` for full/read_only/confirm). `CODEX_HOME=<temp-dir>/codex-home` isolates the session; `config.toml` has `web_search = "disabled"`, `shell_tool = false`, `approval_policy` per mode, and the `mcp_servers.devterm` HTTP entry. `~/.codex/auth.json` is copied in if present. Tool prefix `mcp__devterm__<name>`. Briefing: `AGENTS.md`.

Built-in local fs/shell tools are intentionally disabled in every agent (claude keeps Read/Write/Edit for local scratch only) so the model cannot read or write the operator's machine; everything the model does goes through the MCP bridge, which runs on the shared `ssh2` client for the session. The agent's terminal output is raw and must not be parsed as state.

Bridge state is reported by main over `agent:bridge-status:<sessionId>` based on actual MCP HTTP activity. States: `starting`, `listening`, `connected`, `disconnected`, `stopped`, `error`. The controller also emits `disconnected` (SSH down/reconnecting), `connected` (SSH reconnected), `error` (reconnect/auto-restart failed), and `stopped` (agent exited). Recoverable states show a Restart button that re-runs `agent:open` (which closes the old bridge/temp dir first). The agent PTY is **not** killed on its own exit — the bridge stays up so the agent can auto-restart in place after an SSH reconnect (using the saved `lastOpts`); the bridge + temp dir are only cleaned up on explicit close. The bridge disables Node HTTP idle/request/socket timeouts and sends a standard MCP `notifications/message` heartbeat every 25 seconds while the agent's SSE stream is connected, so a quiet agent session does not look stale.

The renderer pushes the remote shell's live cwd over `agent:set-cwd` (driven by OSC 7); tools run commands and resolve relative paths against it without restarting the agent. Confirmation requests (`agent:confirm`) flow main→renderer and replies (`agent:confirm:reply`) flow back; a 120-second timeout resolves `'timeout'` (distinct from explicit `'denied'`).

DevTerm policy modes (`src/main/mcp/policy.ts`):

- `read_only`: blocks mutating commands and writes (denylist over a cooperative agent — `full` is the only honestly-unrestricted mode).
- `confirm`: asks for mutating/destructive commands and writes.
- `full`: allows commands and writes without DevTerm approval prompts.

Approval rules (`userData/approval-rules.json`, `src/main/approval-rules.ts`) are a PRE-CHECK: an explicit `allow` or `deny` rule (longest-prefix match with token-boundary check, per-session or global) short-circuits the mode verdict; an `ask` rule falls through to the mode-based decision. The current UI defaults the agent to `full`/bypass mode. If a workflow needs operator prompts, switch the mode before opening the agent.

Bridge activity (`src/main/bridge-activity.ts`) logs tool calls, approval requests/outcomes, transport, heartbeats, and bridge state to a per-session in-memory ring (500 entries) plus a `userData/bridge-activity.jsonl` tail (5000 lines). `AgentActivityPanel.tsx` renders the timeline with All/Tools/Approvals/Errors filters; Clear drops the in-memory view but keeps the on-disk tail.

Attention signals (`src/renderer/lib/attention.ts`) are agent-only (never plain shells): a Web Audio chime, OS notification + taskbar flash (`window:flash-attention`, only when backgrounded), a tab needs-attention badge, and an idle-after-burst detector armed on operator keystroke / agent launch that chimes when sustained output goes quiet. Gated by `attention` settings; the agent's idle heuristic is separate from the shell bell.

### Agent Guardrails UI

The Settings modal has an "Agent guardrails" section that lists, adds, and removes approval rules. Each rule has a `commandPrefix` + `outcome` (`allow`/`deny`/`ask`) and is optionally scoped to a specific remote session. Rules added via the "Remember my choice" checkbox in the confirm modal appear here on focus. The longest-prefix + token-boundary match is unit-tested in `src/main/approval-rules.test.ts` (the pure `matchRules` helper is exported for testing without importing Electron).

### Known SSH Hosts

A "Known hosts…" button on the Connections manager opens a panel that lists every trusted host (sha256 fingerprint) and lets the operator "Forget" one with a confirmation. Forgetting a host means the next connect re-triggers the TOFU `hostkey-new` status so the operator can re-accept the key — useful when a host was legitimately re-provisioned. Backed by `src/main/ssh/knownHosts.ts` (`list()` / `remove(hostId)`) over `userData/known_hosts.json`.

### Agent Activity Export

The `AgentActivityPanel` has an "Export" button that writes the session's bridge activity (in-memory ring + on-disk tail, merged and ts-sorted) to a JSONL file at a user-chosen path (native save dialog). The file is JSONL so each line is a self-describing `BridgeActivityEntry`. Useful for auditing or sharing an agent run.

### QuickConnect

`userData/quick-connect.json` stores the most-recently-used `host:port:user` triples (capped at 20, deduped). `ConnectionForm` loads the list on open and renders a `<datalist>` next to the host input; every connect (ad-hoc or saved) calls `quickConnect.record` to bump the entry to the top. The bridge URL travels through `setBackgroundColor` (no — through `IPC.quickConnectRecord`); no secrets are stored, only the target.

### Workspace Auto-Launch

A workspace with `autoLaunch: true` opens in its own group on every app boot. Multiple auto-launch workspaces all open in the order returned by `workspaces.list()`. Auto-launching on boot does NOT count as an operator-initiated launch (the `recordLaunch` flag is false on the boot path) — only clicking the Launch button bumps `launchCount` / `lastLaunchedAt`. The toggle is a checkbox on the WorkspacesManager row next to the launch stats.

### Git Panel

A Warp-style Git sidebar (`src/renderer/components/git/*`) follows the active session's cwd (local or remote). All ops go through `window.devterm.git`; the IPC layer (`src/main/ipc/git.ts`) runs local ops via `child_process` and remote ops over the session's existing exec channel (never a new SSH connection). Git logic lives in `src/main/git.ts` (the stale "strictly read-only" header comment is wrong — the full write-side is implemented) with shell quoting in `src/main/shell-quote.ts`.

Read-side: `status` (porcelain v1, capped at 5000 entries), `diff`, `branches` (for-each-ref), `remotes`, `log` (topo-order, NUL-separated), `stash`, `tags`, `fileAt` (`git show <ref>:<file>`), `blame`, `show` (commit + numstat + patch), `fullDiff` (optional staged/file filter), `contributors` (shortlog).

Write-side (returns `GitCommandResult` `{ ok, code, stdout, stderr, timedOut }`): `checkout` (`-b`/`-f`), `createBranch` (`--track`/`from`/`-f`), `deleteBranch` (`-d`/`-D`), `renameBranch`, `fetch` (`--prune`), `pull` (`--rebase`), `push` (`--force-with-lease`, `-u`), `stashApply`/`stashDrop`/`stashPop`, `commit` (optional `files` to stage first, `--amend`, `--signoff`), `stage`/`unstage`/`discard`, `tagCreate`/`tagDelete`, `addRemote`/`removeRemote`, `merge` (`--no-ff`, message). Network ops use a 120s timeout; others 30s.

`onChange` subscribes to live status: main polls every 5s per watched target and only pushes when a signature changes; `watch` is the explicit start-poll nudge. Every write invalidates the 5s status cache so the next read re-runs git. The panel has six tabs (Changes/Branches/Log/Stash/Tags/Remotes) with modals for commit/new-branch/new-tag/new-remote and a VSCode Git Graph-style SVG lane renderer (`GitGraphView.tsx` + `gitGraphLayout.ts`).

### Persistent Transfer Queue

A persistent transfer queue (`src/main/transfers/queue.ts` + `store.ts`, IPC in `src/main/ipc/transfers.ts`) survives restarts. Items are `TransferItemV2` rows in `userData/transfers.json` (atomic writes). On load, any item still in-flight is marked `canceled` with error `"interrupted by restart"` — there is no byte-range resume; users retry manually. The queue reuses the SSHManager's SFTP channel (no new connection), runs with concurrency 2, throttles progress to 250ms per item, and supports `enqueueUpload`/`enqueueDownload`, `cancel` (destroys streams), `retry` (new id, same paths), and `clearFinished`. `TransfersPanel.tsx` is the bottom-docked UI. The legacy non-persistent `TransferManager` (`src/main/transfer.ts`) is kept solely for the self-test — both the SftpBrowser and the file browser use the persistent queue.

### Voice Dictation (STT)

Offline Whisper speech-to-text into the active terminal, renderer-only (no IPC). `src/renderer/lib/stt/dictation.ts` owns a `DictationController` singleton; `stt.worker.ts` runs the Transformers.js Whisper pipeline (prefers WebGPU, falls back to WASM; models fetched from HF once and cached via the browser Cache API in `persist:browser`; ORT wasm served locally from `/ort/`). `audioCapture.ts` + `pcmWorklet.ts` capture mic audio (getUserMedia, mono, echo cancellation/noise suppression/AGC) and resample to 16 kHz mono. Transcripts are sent to the active terminal via `sendToActive()`; a hallucination guard ignores <2-char output. Push-to-talk: hold the dictate hotkey (Ctrl/Cmd+Shift+M) to record, release to transcribe. The toolbar `MicButton` is hidden when `stt.enabled` is false; `DictationStatus` is a floating pill (visible even in zen mode). Settings: model (tiny/base/small), language (auto + 13 langs), append-space, show-floating-status, and a clear-cached-model action. The main window grants the `media` permission so packaged Electron doesn't deny the mic; audio never leaves the machine. `@huggingface/transformers` and the `ort/*.wasm` files are `asarUnpack`ed so the WASM instantiates over `file://`.

### Global Search

`src/main/search/index.ts` is an in-memory `SearchIndex` (max 2000 lines per session). Local PTY data chunks are pushed live (`ipc/pty.ts`); remote SSH shell data is also pushed live (`ipc/ssh.ts`, cleared on `sshExit`). `search:seed` bulk-seeds from xterm's rendered buffer on mount. `search:query` does case-insensitive substring matching and returns `{ sessionId, sessionTitle, lineNumber, text, kind }`. `GlobalSearchModal.tsx` (Ctrl/Cmd+Alt+F) shows results and jumps to the session/line. The index is in-memory only; killing a session clears its lines. When `searchPersist` is on, an optional per-session JSONL tail at `userData/search/<sessionId>.jsonl` (5000 lines, FIFO) keeps recent output searchable across restarts. See the QuickConnect / Workspace Auto-Launch sections above for adjacent operator-facing flows.

### Auto-Update

`src/main/updater.ts` wires `electron-updater` (skipped in dev and `--self-test`). `autoDownload = true`, `autoInstallOnAppQuit = true`; on `update-downloaded` it prompts "Restart now / Later" and `quitAndInstall`s on restart. Publish provider is `github:AEmad99/devterm` (default `latest` feed); `verifyUpdateCodeSignature: false` because builds are unsigned.

### Settings, Theme, And Keyboard Flow

Settings live in `src/renderer/store/settings.ts` and persist to the renderer's `localStorage` (`devterm.settings.v1`) — not to `userData`. Themes live in `src/renderer/lib/themes.ts`.

One theme drives both the app chrome and xterm ANSI palette. `applyTheme()` writes CSS variables to the document root. `styles.css` derives surfaces, borders, hovers, muted colors, and accent treatments from those variables. Prefer CSS variables and `color-mix`; avoid hardcoded colors unless there is a specific reason.

Settings include: `themeId`, `terminalBg` (color/image/dim), `prefs` (fontSize, fontFamily, lineHeight, cursorStyle, cursorBlink, scrollback, copyOnSelect, rightClickPaste, scrollSensitivity, bell), `autoReconnect`, `attention` (enabled/sound/volume/system/idle), `showStatusBar`, `agentActivityCollapsed`, `inactivePaneDimming`, `sftpSidePane`, `activityIndicators`, `zenMode`, `agentKind`, `transfersPanelOpen`, `defaultShell` (auto/pwsh/powershell/cmd/custom), `gitPanelOpen`, `keybindings`, and `stt`. `setAutoReconnect` pushes the policy live to main.

The Settings modal sections: Theme, Text & cursor, Behavior, Notifications, Voice dictation, Default local shell, Connection (auto-reconnect), Background image, Keyboard (per-action editable shortcuts via `captureCombo`, with per-row and full reset), and Data (export/import backup). Settings export/import (`src/main/settings-io.ts`) produces a versioned (`version: 1`) `SettingsExportBundle` via native dialogs; secret fields (password/passphrase/privateKeyPath, including the nested bastion `jump`) are stripped on export, and import always merges (never replaces) so a mistaken import can't nuke saved connections. `settings:imported` notifies the renderer to reload.

Keyboard shortcuts (`src/renderer/lib/hotkeys.ts`): 24 ids (palette, newTerminal, newGrid, closeTerminal, duplicateTerminal, toggleSidebar, find, clearTerminal, zoom in/out/reset, next/prevTerminal, next/prevTab, toggleFocus, toggleZenMode, settings, globalSearch, shortcuts, saveEditor, dictate). `mod` = Ctrl/Cmd; combos avoid bare Ctrl+letter (readline collisions) via Shift variants except the palette (Ctrl/Cmd+K). Shortcuts are user-overridable per-id; aliases are hidden from the shortcuts sheet.

The BrowserWindow must stay framed and opaque so native Windows snapping works like any other app. The Glass theme is an in-app translucent surface treatment on Electron 29; `window:set-glass` can enable native Acrylic/Mica only when a future Electron build supports it.

Motion is CSS-only near the end of `styles.css`, guarded by reduced-motion media queries. Animate opacity and transform only. Do not animate xterm viewport geometry or use scale on terminal text.

### Window Management Flow

DevTerm uses a normal framed BrowserWindow. Windows owns window movement, resizing, Snap Layouts, edge snapping, maximize/restore, minimize, close, and the system menu. Do not implement custom snap buttons, custom edge snapping, or fake window controls in the renderer.

- `src/main/index.ts` creates the BrowserWindow with `frame: true`, `transparent: false`, `autoHideMenuBar: true`, `autoplayPolicy: 'no-user-gesture-required'` (so the attention chime plays without a prior gesture), `backgroundThrottling: false` (so background timers/keepalives/watches/transfers and the AudioContext stay alive), and `webviewTag: true`.
- `src/main/ipc/window.ts` only handles optional window material hooks such as `window:set-glass` and `window:flash-attention`; it must not own snapping or window-control behavior.
- `App.tsx` has an in-app toolbar, not a draggable custom titlebar.
- Chromium disk/session caches are pinned into `userData` (`Cache`, `SessionData`) before ready to avoid Windows `%LOCALAPPDATA%` lock errors; GPU shader disk cache is disabled.
- `app.setAppUserModelId('com.devterm.app')` attributes OS notifications to DevTerm.
- The top frame is locked to the app bundle (navigation/redirect denials) so a hostile page can never inherit the preload bridge.

## Process And IPC Architecture

DevTerm has three layers:

- Main process (`src/main`): Electron windows, IPC handlers, node-pty, SSH/SFTP, port forwards, filesystem, transfers, MCP bridge, git, search index, auto-updater, persistence.
- Preload (`src/preload/index.ts`): the only typed bridge exposed to the sandboxed renderer.
- Renderer (`src/renderer`): React UI, Zustand state, xterm, CodeMirror, browser panes, dictation worker.

All renderer-to-main capabilities must be represented in `src/shared/types.ts` (the `IPC` channel map + `DevTermApi` surface), implemented in a main IPC handler, and exposed in preload. The renderer is sandboxed with `contextIsolation: true`, `nodeIntegration: false`, and `sandbox: true`. Streaming channels (pty/ssh data, watch events, transfers, bridge activity, git onChange) use the per-id suffix convention and the coalescer in `src/main/ipc/coalesce.ts`.

## Code Map

| Area | Code |
| --- | --- |
| App entry and BrowserWindow | `src/main/index.ts` |
| IPC registration | `src/main/ipc/*`, `src/main/foundation-ipc.ts` |
| Shared contracts | `src/shared/types.ts` |
| Preload API | `src/preload/index.ts` |
| Top-level app and view routing | `src/renderer/App.tsx` |
| Chrome (toolbar/nav/group bar/status bar) | `src/renderer/components/chrome/*` |
| Session store | `src/renderer/store/sessions.ts` |
| Layout store | `src/renderer/store/layout.ts` |
| Settings store | `src/renderer/store/settings.ts` |
| Editor store | `src/renderer/store/editors.ts` |
| Dictation store | `src/renderer/store/dictation.ts` |
| Transfers store | `src/renderer/store/transfers.ts` |
| Local PTY manager | `src/main/pty/manager.ts` |
| SSH manager / connection / OS detect / port forward | `src/main/ssh/manager.ts`, `connection.ts`, `osDetect.ts`, `port-forward.ts`, `knownHosts.ts` |
| SFTP helpers / remote watch | `src/main/ssh/sftp.ts`, `watch.ts` |
| File APIs and local watch | `src/main/fs/*` |
| Legacy live transfers (self-test only) | `src/main/transfer.ts` |
| Persistent transfer queue | `src/main/transfers/queue.ts`, `store.ts`, `src/main/ipc/transfers.ts`, `src/renderer/components/transfers/TransfersPanel.tsx` |
| Git logic / IPC / shell quoting | `src/main/git.ts`, `src/main/ipc/git.ts`, `src/main/shell-quote.ts` |
| Git panel UI | `src/renderer/components/git/*` |
| Terminal layout / view / remote wrapper | `src/renderer/components/terminal/TerminalLayout.tsx`, `TerminalView.tsx`, `RemoteSessionView.tsx` |
| Terminal grid | `src/renderer/components/terminal/CreateGridModal.tsx`, `src/renderer/lib/createGrid.ts`, `grid.ts` |
| Port forward UI | `src/renderer/components/terminal/PortForwardPanel.tsx` |
| Agent pane / activity panel | `src/renderer/components/agent/AgentPane.tsx`, `AgentActivityPanel.tsx` |
| MCP bridge / tools / policy | `src/main/mcp/server.ts`, `tools.ts`, `policy.ts` |
| Agent launch/context/extension | `src/main/agent/launch.ts`, `claude-launch.ts`, `opencode-launch.ts`, `kimi-launch.ts`, `grok-launch.ts`, `codex-launch.ts`, `context.ts`, `extension.ts` |
| Bridge activity / approval rules / settings I/O | `src/main/bridge-activity.ts`, `approval-rules.ts`, `settings-io.ts` |
| Browser pane + enhancements | `src/renderer/components/terminal/BrowserPane.tsx`, `src/main/ipc/browser.ts`, `src/main/browser-zoom.ts` |
| File explorer/tree/SFTP browser/editor | `src/renderer/components/files/*` |
| Markdown preview | `src/renderer/lib/markdown-preview.ts`, `src/renderer/components/files/MarkdownPreview.tsx` |
| Workspaces | `src/main/ipc/workspaces.ts`, `src/renderer/lib/workspace.ts`, `src/renderer/components/workspaces/*` |
| Connections | `src/main/ipc/connections.ts`, `src/renderer/components/connections/*` |
| Snippets | `src/main/ipc/snippets.ts`, `src/renderer/components/snippets/*` |
| Command history | `src/main/ipc/history.ts` |
| Command palette and hotkeys | `src/renderer/components/modals/CommandPalette.tsx`, `src/renderer/lib/hotkeys.ts`, `history-frecency.ts` |
| Voice dictation (STT) | `src/renderer/lib/stt/*`, `src/renderer/components/dictation/*` |
| Global search | `src/main/search/index.ts`, `src/main/search/persist.ts`, `src/renderer/components/modals/GlobalSearchModal.tsx` |
| QuickConnect recent hosts | `src/main/quick-connect.ts`, `src/renderer/components/connections/ConnectionForm.tsx` |
| Attention signals / tab status / tab labels | `src/renderer/lib/attention.ts`, `tab-status.ts`, `tab-label.ts` |
| Themes | `src/renderer/lib/themes.ts`, `src/renderer/styles.css` |
| Window appearance / attention hooks | `src/main/ipc/window.ts` |
| Auto-updater | `src/main/updater.ts` |
| Self-test | `src/main/selftest.ts`, `selftest-sftp.ts` |
| Unit tests | `src/main/mcp/policy.test.ts`, `approval-rules.test.ts`, `shell-quote.test.ts`, `src/renderer/lib/{tab-label,tab-status,snippets}.test.ts`, `src/renderer/components/modals/extractCommandPrefix.test.ts` |
| Packaging | `electron-builder.yml`, `package.json`, `scripts/setup-native.mjs` |

## Persistence

In Electron `userData`:

- `connections.json`: saved SSH connections, atomic writes, secret fields (including the nested bastion `jump`) encrypted with Electron `safeStorage` when available.
- `workspaces.json`: saved terminal groups and layouts (each workspace may carry `autoLaunch?: boolean` to open on app startup), no secrets.
- `snippets.json`: saved command snippets, no secrets.
- `approval-rules.json`: agent guardrail rules (allow/deny/ask, per-session or global), no secrets.
- `known_hosts.json`: TOFU host keys, mode `0o600`. Viewable/removable from the "Known SSH hosts" panel in the Connections manager.
- `transfers.json`: persistent transfer queue (in-flight items marked interrupted on restart). The only transfer path — the legacy non-persistent `TransferManager` (`src/main/transfer.ts`) is kept solely for the self-test.
- `browser-zoom.json`: per-origin browser zoom levels.
- `bridge-activity.jsonl`: per-session bridge activity tail (5000 lines, rotated). Exportable from `AgentActivityPanel` to a JSONL file via the native save dialog.
- `settings.json`: the renderer's full `AppSettings` snapshot, kept in sync by the `settings:sync` IPC. The export bundle reads this file (so it has the latest settings) and the import flow re-applies the same snapshot to the renderer via `settings:imported`.
- `search/<sessionId>.jsonl`: optional per-session search tail (only when `settings.searchPersist` is on; 5000 lines/session, FIFO). Lets global search hit recent closed-session output.
- `quick-connect.json`: most-recently-used `host:port:user` triples (capped at 20, deduped). Drives the host datalist in `ConnectionForm`.
- `Downloads/`: browser pane download destination.

In the renderer's `localStorage`:

- `devterm.settings.v1`: all user settings (theme, terminal prefs, auto-reconnect, attention, zen mode, agent kind, default shell, git panel, keybindings, STT, search persist, etc.), no secrets. The same snapshot is mirrored to `userData/settings.json` by the `settings:sync` IPC so the export bundle can capture it.

In-memory only: renderer sessions, layout state, group flags, open editors, transfer runtime, agent (pi/claude/opencode/kimi/grok/codex) processes, the global search index (unless `searchPersist` is on), and dictation state.

## Commands

- `npm run setup`: first-time setup. Fetches Electron and the node-pty prebuilt. Do not run `npm rebuild` for node-pty on this machine.
- `npm run dev`: electron-vite development mode.
- `npm run build`: electron-vite bundle to `out/`.
- `npm run preview`: electron-vite preview.
- `npm run typecheck`: required correctness gate for main, preload, shared, and renderer TypeScript.
- `npm run lint`: ESLint for `src`.
- `npm run format` / `npm run format:check`: Prettier for source files (`src/**/*.{ts,tsx}`).
- `npm run test`: run all `*.test.ts` unit tests (policy, approval-rules, shell-quote, tab-label/tab-status, snippets, extractCommandPrefix, markdown-preview) via `tsx --test "src/**/*.test.ts"`.
- `npm run test:grid`: grid-spec validation (`scripts/assert-grid.mjs`).
- `npm run build:win`: bundle and build unsigned Windows NSIS x64 installer into `dist/`.
- `npm run build:linux`: bundle and build Linux AppImage.
- `npm run release:win` / `release:linux`: bundle, build, and publish (`--publish always`).
- `node scripts/smoke.cjs`: quick runtime smoke test for node-pty and ssh2.
- `electron . --self-test`: headless self-test with a 90 second watchdog.

## Packaging And Release

The application version is `package.json` `version` (currently `1.3.0`). A Windows build produces `dist/DevTerm-<version>-setup.exe` plus `latest.yml` and a blockmap.

Windows packaging uses `electron-builder.yml`:

- `appId: com.devterm.app`
- `productName: DevTerm`
- NSIS x64 target (`oneClick: false`, `perMachine: false`, `allowToChangeInstallationDirectory: true`)
- unsigned build (`verifyUpdateCodeSignature: false`)
- `asarUnpack` for `node-pty` and `ort/*.wasm` (onnxruntime wasm for local STT)
- `npmRebuild: false` (node-pty is a prebuilt matching Electron's ABI)
- Linux AppImage target
- GitHub publish provider `AEmad99/devterm`

For release replacement, build locally first, then update the GitHub release/tag intentionally. Typical flow:

1. Verify: `npm run typecheck`, `npm run lint`, `npm run test`, `node scripts/smoke.cjs`.
2. Build: `npm run build:win` (or `release:win` to publish in one step).
3. Commit to `main`.
4. Push `main`.
5. Move or recreate the tag (e.g. `v1.3.0`) if the user explicitly wants to override the existing version.
6. Upload `dist/DevTerm-<version>-setup.exe`, `.blockmap`, and `latest.yml` to the matching release with clobber semantics.

## Critical Rules

- Keep terminals mounted. Hide with CSS (`.term-hidden`); do not unmount `TerminalLayout` for top-level view changes.
- Keep xterm instances in stable DOM slots. Do not reparent terminal nodes during layout, group switching, drag/drop, focus mode, or zen mode.
- Keep node-pty prebuilt and `asarUnpack` intact. Do not rebuild node-pty locally. Keep `ort/*.wasm` `asarUnpack`ed so local STT works.
- Add IPC capabilities through shared types (`IPC` + `DevTermApi`), main handler, and preload exposure together.
- Use the existing SSH client for shell, SFTP, watches, exec, port forwards, git remote ops, and agent tools. Do not open hidden duplicate SSH connections.
- Preserve OSC 7 cwd tracking and OSC 133 prompt markers for local and remote shells.
- Use `FsApi.watch()` for live listings. Do not bring back manual refresh as a primary update path.
- Respect the MCP policy boundary in new tools. Approval rules are a PRE-CHECK that overrides the mode for `allow`/`deny`.
- Treat agent terminal output as user-facing terminal data, not application state. Do not kill the agent PTY on its own exit — the bridge stays up for auto-restart after SSH reconnect.
- Git is no longer read-only — the write-side (commit/stage/push/merge/etc.) is implemented in `src/main/git.ts`. The stale "strictly read-only" header comment there is wrong.
- Port-forward `add`/`remove` are implemented for local `-L`; only dynamic `-D` SOCKS is stubbed (the stale `foundation-ipc.ts` header claiming add/remove are stubs is wrong).
- Settings persist to renderer `localStorage`, not `userData`. Export/import bundles are versioned JSON with secrets stripped.
- Transfers do not resume mid-file across restarts — in-flight items are marked interrupted; users retry.
- Local PTY AND remote SSH shell output both feed the global search index live (the SSH path was added in 1.3.0). Closing a session clears its in-memory lines; with `settings.searchPersist` on, the per-session JSONL tail keeps recent output searchable across restarts.
- Use theme CSS variables instead of hardcoded palettes.
- Keep motion out of xterm viewport and behind reduced-motion guards.
- Keep the BrowserWindow normal/framed and let Windows handle snapping; do not add custom snap controls or edge-snapping logic.
- Commit directly to `main` unless the user asks for a branch or PR.
