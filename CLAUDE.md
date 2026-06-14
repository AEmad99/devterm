# CLAUDE.md

This file guides Claude Code when working in the DevTerm repository.

DevTerm is an Electron desktop terminal for local shells, SSH/SFTP sessions, terminal workspaces, file browsing and editing, an in-app browser, saved command snippets, and an embedded pi coding agent bridge. It is built with Electron 29, electron-vite, TypeScript strict mode, React 18, Zustand, xterm.js, ssh2, CodeMirror 6, and a prebuilt node-pty native module. The pi agent is loaded via the `@earendil-works/pi-coding-agent` npm package and runs as a real interactive CLI in a local node-pty.

## Product Shape

DevTerm is a normal framed desktop application so Windows owns the titlebar, resize border, Snap Layouts, edge snapping, minimize/maximize/close controls, and system menu. The first screen is the working terminal interface, not a marketing page. The in-app top toolbar hosts the app brand, the top-level view switcher, settings, and keyboard shortcuts.

The top-level views are:

- **Terminals**: the always-mounted terminal workspace. It contains group tabs, split panes, pane tabs, local shells, remote SSH terminals, browser panes, and editor overlays.
- **Connections**: saved SSH connection management. Users create, edit, connect, and delete saved connection profiles.
- **Workspaces**: saved terminal groups. Users launch saved sets of terminals and split layouts into their own group.
- **Snippets**: saved command snippets. Users manage commands that can be sent to the active terminal directly or through the command palette.

Terminal panes can host:

- A local shell (`kind: 'local'`).
- A remote SSH shell (`kind: 'remote'`).
- An in-app browser pane (`kind: 'browser'`).

Remote SSH panes can also open:

- A file browser/SFTP view.
- A pi agent side pane connected to the remote host through DevTerm's MCP bridge.

## User Flows

### Startup

`src/renderer/App.tsx` mounts the app. On first load it asks the main process for local host context and opens one local terminal if no sessions exist. The Terminals view stays mounted throughout the app lifetime so local PTYs, SSH shells, browser panes, and agent panes are not destroyed by view navigation.

### Opening Terminals

New terminals are opened from `NewTerminalModal.tsx`. Users open it by pressing the pane tab strip plus button, double-clicking empty tab-strip space, using the global new-terminal hotkey, or clicking an empty-state call to action. The picker offers:

- Local shell: `useSessions.addLocal()` creates an in-memory session. `TerminalView` mounts xterm and asks main IPC to create a local PTY.
- SSH connection: `ConnectionForm` or `ConnectionsManager` calls `useSessions.connectSsh()`. The main process creates one ssh2 client for the session, detects host context, and later opens a shell channel for xterm.
- Browser pane: `useSessions.addBrowser()` creates a browser session. `TerminalLayout` routes it to `BrowserPane`, which hosts Electron `<webview>` tabs.

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
- Drag split handles to resize panes.
- Merge a pane back into another pane.

Pane sizing must preserve usable windows. Split minimums, nested split spans, visible pane edges, and split handle styling are there to keep one pane from collapsing another into an unusable sliver.

### Focus Mode

Focus mode magnifies the active session without reparenting it. It is controlled by `focusedId` in `store/layout.ts` and entered by Ctrl/Cmd+Shift+Z, the per-pane focus button, or pane UI. Esc, backdrop click, or the floating close button exits focus mode.

`TerminalLayout` repositions the focused `.term-slot` with fixed insets and a raised z-index. Pane chrome is hidden while focused. The terminal's existing ResizeObserver refits xterm to the new size. Animations must not scale xterm because scaled terminal text blurs.

### Local Terminal Flow

`TerminalView.tsx` creates an xterm instance and loads Fit, Search, and WebLinks addons. For local sessions it calls:

- `window.devterm.pty.create()` through preload.
- `src/main/ipc/pty.ts`.
- `src/main/pty/manager.ts`.

`PtyManager` chooses a default shell, preferring PowerShell on Windows, and injects a PowerShell prompt function that emits OSC 7 directory updates. Explicit shell args, such as the `pi` CLI launch, bypass prompt injection.

Terminal data returns over `pty:data:<id>`. Exit events return over `pty:exit:<id>`.

### Remote SSH Flow

Saved and ad-hoc SSH sessions go through:

- Renderer store: `src/renderer/store/sessions.ts`.
- IPC: `src/main/ipc/ssh.ts`.
- Manager: `src/main/ssh/manager.ts`.
- Connection setup: `src/main/ssh/connection.ts`.

Each remote session owns one ssh2 client. The interactive shell, SFTP channel, exec channels, directory watch polling, and agent tools all reuse that same client. Do not create a second SSH connection for features bound to an existing session.

Host keys are trust-on-first-use through `knownHosts.ts` and stored in Electron `userData`, not `~/.ssh`. Host key mismatches are rejected.

Remote SSH dials its own TCP socket with `setNoDelay(true)` before handing it to ssh2. Keep that path intact; without TCP_NODELAY interactive SSH feels laggy.

Remote POSIX shells receive a small OSC 7 hook (`__dt7`) after shell open so the renderer can track the current working directory. Preserve the OSC 7 behavior when editing shell setup.

### Files, SFTP, And Editing

The left `FileExplorer` follows the active shell working directory. Local sessions browse local filesystem IPC; remote sessions browse through SFTP on the active SSH session. Browser panes show a no-files placeholder.

`SftpBrowser.tsx` provides dual local/remote panes for transfers. `FilePane`, `FileExplorer`, and `FileTree` share the `FsApi` abstraction in `src/renderer/lib/fsapi.ts`.

Directory listings live-update:

- Local watch: `src/main/fs/watch.ts`, using `fs.watch` plus a safety poll.
- Remote watch: `src/main/ssh/watch.ts`, using SFTP polling because SFTP has no inotify.
- Renderer subscriptions: `FsApi.watch()`.

Avoid manual refresh patterns for new listing views. Use `FsApi.watch()` and let main diff directory signatures.

File editing uses CodeMirror 6 in `EditorView.tsx`. File contents cross IPC as UTF-8 text with size and mtime metadata. Large files are limited by `MAX_EDIT_BYTES` in `src/shared/types.ts`.

### Browser Pane Flow

`BrowserPane.tsx` hosts Electron `<webview>` tabs with the persistent partition `persist:browser`. Main process hardens guests in `src/main/index.ts`:

- Popup handling sends `browser:open-tab` to the renderer so the pane can create a tab.
- External links can be sent to the OS browser.
- The browser partition strips DevTerm/Electron tokens from the user agent for more normal web compatibility.

Browser panes are sessions, so they participate in groups, tabs, splitting, and focus mode but do not create PTYs or SSH channels.

### Snippets And Command Palette

Snippets are persisted in `userData/snippets.json` through `src/main/ipc/snippets.ts`. Renderer helpers live in `src/renderer/lib/snippets.ts`. The command palette (`CommandPalette.tsx`) filters snippets and sends commands to the active terminal through `lib/input.ts`.

Snippets can contain `{{placeholders}}`. Parameterized snippets prompt before running. Plain snippets can run directly into the active terminal.

### Workspaces

Workspaces are persisted in `userData/workspaces.json`. A workspace stores:

- `items`: local or remote terminal descriptors, saved connection ids, optional cwd, and title.
- `layout`: a split snapshot whose leaf tabs reference workspace item ids, not live session ids.

Capture starts in the Terminals view through the group bar's Save group action. `renderer/lib/workspace.ts` builds the snapshot from the active group. Launching a workspace creates a new group, opens each terminal, maps workspace item ids to live session ids, and restores the split tree.

Ad-hoc SSH sessions without a saved `connectionId` are skipped during capture because DevTerm cannot reconnect them later without credentials.

### Agent Bridge (Pi)

The embedded agent is the real interactive `pi` CLI process (the `pi` coding agent from `@earendil-works/pi-coding-agent`) spawned in a local PTY. It is not the API or SDK. The launch flow is:

- Renderer: `RemoteSessionView.tsx` opens `AgentPane.tsx` beside a remote terminal.
- IPC: `src/main/ipc/agent.ts`.
- Launch prep: `src/main/agent/launch.ts` (writes `AGENTS.md` + the per-session pi extension, picks the `pi` binary).
- Agent instructions: `src/main/agent/context.ts` (host briefing, air-gapped rules, MCP tool map).
- pi extension source: `src/main/agent/extension.ts` (a TypeScript string the launch step writes to disk and pi loads via `-e`).
- MCP bridge: `src/main/mcp/server.ts` (transport-agnostic; could feed any MCP client).
- Tools: `src/main/mcp/tools.ts`.
- Policy: `src/main/mcp/policy.ts`.

For each agent session DevTerm:

1. Starts an in-process MCP server on `127.0.0.1:<random-port>` gated by a random bearer token.
2. Writes a per-session working directory containing `AGENTS.md` (the host briefing) and `devterm-mcp.mjs` (the pi extension source).
3. Spawns `pi` in a node-pty with:
   - `--no-session` (don't persist to `~/.pi/agent/sessions/`)
   - `--no-builtin-tools` (scope the agent to MCP tools; no local fs/shell)
   - `-e <abs-path>/devterm-mcp.mjs` (load our MCP bridge adapter)
   - `--offline` (skip pi's startup network checks)
4. The pi extension reads `DEVTERM_BRIDGE_URL` / `DEVTERM_BRIDGE_TOKEN` from the inherited env, performs the MCP `initialize` → `notifications/initialized` → `tools/list` handshake with `fetch` against the bridge, and re-registers each discovered tool with pi as `mcp__devterm__<name>`. Tool calls go back through the same bridge as streamable-HTTP POSTs.

Built-in pi tools are intentionally disabled so the agent cannot read/write the local machine; everything the model does goes through the MCP bridge, which runs on the shared `ssh2` client for the session. The agent's terminal output is raw and must not be parsed as state. Bridge state is reported by main over `agent:bridge-status:<sessionId>` based on actual MCP HTTP activity. The UI shows connecting, waiting, connected, disconnected, stopped, error, and exited states. Recoverable states show a Restart button that recreates the bridge and agent process. The bridge disables Node HTTP idle/request/socket timeouts and sends a standard MCP `notifications/message` heartbeat every 25 seconds while the agent's standalone SSE stream is connected, so a quiet agent session does not look stale to the client or OS.

DevTerm policy modes:

- `read_only`: blocks mutating commands and writes.
- `confirm`: asks for mutating/destructive commands and writes.
- `full`: allows commands and writes without DevTerm approval prompts.

The current UI defaults the agent to `full`/bypass mode. If a workflow needs operator prompts, switch the mode before opening the agent.

### Settings And Theme Flow

Settings live in `src/renderer/store/settings.ts` and persist to `userData/settings.json`. Themes live in `src/renderer/lib/themes.ts`.

One theme drives both the app chrome and xterm ANSI palette. `applyTheme()` writes CSS variables to the document root. `styles.css` derives surfaces, borders, hovers, muted colors, and accent treatments from those variables. Prefer CSS variables and `color-mix`; avoid hardcoded colors unless there is a specific reason.

The BrowserWindow must stay framed and opaque so native Windows snapping works like any other app. The Glass theme is an in-app translucent surface treatment on Electron 29; `window:set-glass` can enable native Acrylic/Mica only when a future Electron build supports it.

Motion is CSS-only near the end of `styles.css`, guarded by reduced-motion media queries. Animate opacity and transform only. Do not animate xterm viewport geometry or use scale on terminal text.

### Window Management Flow

DevTerm uses a normal framed BrowserWindow. Windows owns window movement, resizing, Snap Layouts, edge snapping, maximize/restore, minimize, close, and the system menu. Do not implement custom snap buttons, custom edge snapping, or fake window controls in the renderer.

- `src/main/index.ts` creates the BrowserWindow with `frame: true` and `transparent: false`.
- `src/main/ipc/window.ts` only handles optional window material hooks such as `window:set-glass`; it must not own snapping or window-control behavior.
- `App.tsx` has an in-app toolbar, not a draggable custom titlebar.

## Process And IPC Architecture

DevTerm has three layers:

- Main process (`src/main`): Electron windows, IPC handlers, node-pty, SSH/SFTP, filesystem, transfers, MCP bridge, persistence.
- Preload (`src/preload/index.ts`): the only typed bridge exposed to the sandboxed renderer.
- Renderer (`src/renderer`): React UI, Zustand state, xterm, CodeMirror, browser panes.

All renderer-to-main capabilities must be represented in `src/shared/types.ts`, implemented in a main IPC handler, and exposed in preload. The renderer is sandboxed with `contextIsolation: true`, `nodeIntegration: false`, and `sandbox: true`.

## Code Map

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
| Local PTY manager | `src/main/pty/manager.ts` |
| SSH manager | `src/main/ssh/manager.ts` |
| SSH connection setup | `src/main/ssh/connection.ts` |
| SFTP helpers | `src/main/ssh/sftp.ts` |
| File APIs and local watch | `src/main/fs/*` |
| Transfer queue | `src/main/transfer.ts`, `src/renderer/components/TransferQueue.tsx` |
| Terminal layout | `src/renderer/components/TerminalLayout.tsx` |
| Terminal view | `src/renderer/components/TerminalView.tsx` |
| Remote shell/files/agent wrapper | `src/renderer/components/RemoteSessionView.tsx` |
| Agent pane | `src/renderer/components/AgentPane.tsx` |
| MCP bridge and tools | `src/main/mcp/server.ts`, `src/main/mcp/tools.ts`, `src/main/mcp/policy.ts` |
| Agent launch/context | `src/main/agent/launch.ts`, `src/main/agent/context.ts`, `src/main/agent/extension.ts` |
| Browser pane | `src/renderer/components/BrowserPane.tsx` |
| File explorer/tree | `src/renderer/components/FileExplorer.tsx`, `FileTree.tsx` |
| SFTP browser | `src/renderer/components/SftpBrowser.tsx`, `FilePane.tsx` |
| Editor | `src/renderer/components/EditorView.tsx` |
| Workspaces | `src/main/ipc/workspaces.ts`, `src/renderer/lib/workspace.ts`, `WorkspacesManager.tsx` |
| Connections | `src/main/ipc/connections.ts`, `ConnectionForm.tsx`, `ConnectionsManager.tsx` |
| Snippets | `src/main/ipc/snippets.ts`, `SnippetsManager.tsx`, `SnippetForm.tsx` |
| Command palette and hotkeys | `CommandPalette.tsx`, `src/renderer/lib/hotkeys.ts` |
| Themes | `src/renderer/lib/themes.ts`, `src/renderer/styles.css` |
| Window appearance hook | `src/main/ipc/window.ts` |
| Packaging | `electron-builder.yml`, `package.json`, `scripts/setup-native.mjs` |

## Persistence

All persistence is in Electron `userData`:

- `connections.json`: saved SSH connections, atomic writes, secret fields encrypted with Electron `safeStorage` when available.
- `workspaces.json`: saved terminal groups and layouts, no secrets.
- `snippets.json`: saved command snippets, no secrets.
- `settings.json`: theme, terminal background, and terminal preferences, no secrets.

Renderer sessions, layout state, open editors, transfer state, and agent (pi) processes are in-memory only.

## Commands

- `npm run setup`: first-time setup. Fetches Electron and the node-pty prebuilt. Do not run `npm rebuild` for node-pty on this machine.
- `npm run dev`: electron-vite development mode.
- `npm run typecheck`: required correctness gate for main, preload, shared, and renderer TypeScript.
- `npm run lint`: ESLint for `src`.
- `npm run format`: Prettier for source files.
- `npm run build`: electron-vite bundle to `out/`.
- `npm run build:win`: bundle and build unsigned Windows NSIS x64 installer into `dist/`.
- `npm run build:linux`: bundle and build Linux AppImage.
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
- Keep node-pty prebuilt and `asarUnpack` intact. Do not rebuild node-pty locally.
- Add IPC capabilities through shared types, main handler, and preload exposure together.
- Use the existing SSH client for shell, SFTP, watches, exec, and agent tools. Do not open hidden duplicate SSH connections.
- Preserve OSC 7 cwd tracking for local and remote shells.
- Use `FsApi.watch()` for live listings. Do not bring back manual refresh as a primary update path.
- Respect the MCP policy boundary in new tools.
- Treat agent terminal output as user-facing terminal data, not application state.
- Use theme CSS variables instead of hardcoded palettes.
- Keep motion out of xterm viewport and behind reduced-motion guards.
- Keep the BrowserWindow normal/framed and let Windows handle snapping; do not add custom snap controls or edge-snapping logic.
- Commit directly to `main` unless the user asks for a branch or PR.
