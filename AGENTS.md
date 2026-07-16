# AGENTS.md

Guidance for coding agents working in the DevTerm repository.

DevTerm is an Electron 29 desktop terminal: local shells (prebuilt node-pty), SSH/SFTP sessions, workspaces, file browsing/editing (CodeMirror 6), an in-app browser, snippets, a Warp-style Git panel, a persistent transfer queue, offline Whisper dictation, global terminal search, and an embedded coding-agent bridge hosting six CLIs (pi, claude, opencode, kimi, grok, codex) in local PTYs that reach the remote host only through DevTerm's in-process MCP bridge. Stack: electron-vite, TypeScript strict, React 18, Zustand, xterm.js, ssh2, marked + DOMPurify, `@huggingface/transformers`, electron-updater, zod.

Top-level views: **Terminals** (always-mounted workspace: group tabs, split panes, local/remote/browser sessions), **Connections**, **Workspaces**, **Snippets**. DevTerm is a normal framed desktop app; the first screen is the terminal, not a marketing page.

## Architecture

- Main (`src/main`): windows, IPC handlers, node-pty, SSH/SFTP, port forwards, fs, transfers, MCP bridge, git, search index, updater, persistence.
- Preload (`src/preload/index.ts`): the only typed bridge to the sandboxed renderer (`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`).
- Renderer (`src/renderer`): React UI, Zustand stores, xterm, CodeMirror, browser panes, dictation worker.

Every renderer→main capability must be added in all three places together: `src/shared/types.ts` (`IPC` channel map + `DevTermApi`), a main IPC handler, and the preload exposure. Streaming channels use the per-id suffix convention and the coalescer in `src/main/ipc/coalesce.ts`.

## Feature Notes

Non-obvious behavior and code locations. Read the code for details; keep this file short.

### Terminals & layout

- Tiling model: binary split tree in `src/renderer/store/layout.ts`; `TerminalLayout.tsx` computes rects and renders one stable `.term-slot` per session. Inactive groups stay mounted, hidden via `.term-hidden` (visibility + off-screen translate, never `display:none`).
- Focus mode (`focusedId`, Ctrl/Cmd+Shift+Z) and zen mode (`zenMode`, Ctrl/Cmd+Alt+Z) only reposition/hide — never reparent xterm, never scale terminal text (blurs).
- Terminal grids: `CreateGridModal.tsx` + `lib/createGrid.ts` (max 4×4), restored via the shared `restoreGroup` path. Groups launched from workspaces carry `launchedFromWorkspaceId` in `groupFlags` for "Save back".
- Local PTYs: `src/main/pty/manager.ts` picks the shell from the `defaultShell` pref and injects PowerShell OSC 7/133 prompt hooks (explicit shell args bypass injection). A fresh PTY exiting with no output fires `pty:startup-failure:<id>` with a targeted diagnostic.
- Remote SSH: one ssh2 client per session (`src/main/ssh/manager.ts`) shared by shell, SFTP, exec, watch polling, port forwards, git ops, and agent tools. Direct hops set `setNoDelay(true)` — keep it. Single bastion hop via `profile.jump`. TOFU host keys in `userData/known_hosts.json` (mode 0o600; mismatches rejected). Auto-reconnect with exponential backoff is implemented; session ids stay stable across reconnects.
- Remote shells get OSC 7 (`__dt7`) and OSC 133 (`__dtA`/`__dtB`) hooks (idempotent bash/zsh wraps; PowerShell prompt fn on Windows remotes). Preserve when editing shell setup.
- `exec` timeouts resolve `timedOut: true` with partial output — not a disconnect. Port forwarding: local `-L` and dynamic `-D` SOCKS5 (no-auth, CONNECT only) both implemented in `src/main/ssh/port-forward.ts`; UI in `PortForwardPanel.tsx` (stale stub comments elsewhere are wrong).

### Files & editor

- `FileExplorer` follows the active shell cwd: local via fs IPC, remote via SFTP on the same ssh2 client. Shared `FsApi` abstraction in `src/renderer/lib/fsapi.ts`.
- Listings live-update via `FsApi.watch()` (local `src/main/fs/watch.ts`; remote SFTP poll at 2500ms). Do not add manual refresh paths.
- Editor: CodeMirror 6 (`EditorView.tsx`), max 5 MiB (`MAX_EDIT_BYTES`), original EOL re-applied on save; sanitized Markdown preview in `lib/markdown-preview.ts` (marked GFM + DOMPurify).

### Browser panes

- `<webview>` tabs on partition `persist:browser`, hardened in `src/main/index.ts` + `src/main/ipc/browser.ts`: preload stripped, `nodeIntegration: false`, http(s)/about:blank only (other schemes go to the OS browser), sensitive permissions default-denied, UA de-Electroned. Per-origin zoom persisted (`userData/browser-zoom.json`); downloads to `userData/Downloads`. Browser panes are sessions (groups/tabs/splits/focus) but create no PTY or SSH channel.

### Agent bridge

- The agent is a real interactive CLI in a local PTY, not an API/SDK. Per-agent launch layers in `src/main/agent/*-launch.ts` write the briefing + config to a temp dir; briefings built in `src/main/agent/context.ts`.
- MCP bridge (`src/main/mcp/server.ts`) on `127.0.0.1:<random-port>` gated by a random bearer token; tools in `src/main/mcp/tools.ts`; policy modes `read_only`/`confirm`/`full` in `src/main/mcp/policy.ts`. Approval rules (`src/main/approval-rules.ts`, `userData/approval-rules.json`) are a PRE-CHECK: explicit allow/deny short-circuits the mode; `ask` falls through.
- Tool prefixes differ per agent: `mcp__devterm__*` (pi/claude/kimi/codex), `devterm_*` (opencode), `devterm__*` (grok). Built-in local fs/shell tools are disabled in every agent (claude keeps Read/Write/Edit for local scratch) so all host work crosses the bridge over the session's shared ssh2 client.
- Bridge status over `agent:bridge-status:<id>`; MCP `notifications/message` heartbeat every 25s; renderer pushes live cwd via `agent:set-cwd`; confirmations (`agent:confirm`) time out after 120s as `'timeout'`.
- The agent PTY is not killed on its own exit — the bridge + temp dir stay up for auto-restart after SSH reconnect and are only cleaned up on explicit close. Activity log: `src/main/bridge-activity.ts` → `AgentActivityPanel.tsx` (filterable, exportable to JSONL).
- Attention signals (`src/renderer/lib/attention.ts`) are agent-only: Web Audio chime, OS notification + taskbar flash, tab badge, idle-after-burst detector.

### Other features

- Git panel (`src/renderer/components/git/*`, logic `src/main/git.ts`): full read + write side implemented (stale "read-only" header comment is wrong). Remote ops reuse the session's exec channel; `onChange` polls every 5s; writes invalidate the status cache.
- Persistent transfer queue (`src/main/transfers/*`, `userData/transfers.json`): concurrency 2, survives restarts, no mid-file resume (interrupted items marked canceled; users retry). Legacy `src/main/transfer.ts` is self-test-only.
- Voice dictation: renderer-only Whisper (`src/renderer/lib/stt/*`), WebGPU→WASM fallback, push-to-talk (Ctrl/Cmd+Shift+M), models cached in `persist:browser`; `ort/*.wasm` must stay `asarUnpack`ed.
- Global search (`src/main/search/index.ts`): in-memory, 2000 lines/session, fed live by local PTY and SSH output; optional per-session JSONL tail when `settings.searchPersist` is on. Modal: Ctrl/Cmd+Alt+F.
- Workspaces (`userData/workspaces.json`): capture/launch/rename/duplicate/`autoLaunch` on boot; ad-hoc SSH sessions without a saved connection are skipped on capture.
- Snippets (`userData/snippets.json`) support `{{placeholders}}`. Command palette (Ctrl/Cmd+K): fuzzy + frecency, categories Actions/Snippets/Connections/Workspaces/History. History merges DevTerm records with host shell-history files.
- QuickConnect (`userData/quick-connect.json`): MRU `host:port:user` triples (cap 20) drive the host datalist in `ConnectionForm`.
- Settings live in `src/renderer/store/settings.ts`, persist to renderer `localStorage` (`devterm.settings.v1`), mirrored to `userData/settings.json` via `settings:sync`. Export/import (`src/main/settings-io.ts`) strips secrets and always merges. One theme drives chrome + xterm palette via CSS variables (`lib/themes.ts`, `styles.css`) — use variables/`color-mix`, not hardcoded colors. Keybindings: 24 ids in `lib/hotkeys.ts`, user-overridable.
- Window: normal framed opaque BrowserWindow — Windows owns snapping/titlebar; never add custom snap or fake window controls. Key flags: `backgroundThrottling: false`, `webviewTag: true`, `autoHideMenuBar`, caches pinned into `userData`, top frame navigation-locked, `appUserModelId com.devterm.app`.
- Auto-update: `src/main/updater.ts` (electron-updater, GitHub `AEmad99/devterm`, unsigned builds, skipped in dev/self-test).

## Persistence

- `userData`: `connections.json` (secret fields safeStorage-encrypted, incl. bastion `jump`), `workspaces.json`, `snippets.json`, `approval-rules.json`, `known_hosts.json` (0o600), `transfers.json`, `browser-zoom.json`, `bridge-activity.jsonl`, `settings.json` (renderer mirror), `search/<sessionId>.jsonl` (optional), `quick-connect.json`, `Downloads/`.
- Renderer `localStorage`: `devterm.settings.v1` (all settings, no secrets).
- In-memory only: sessions, layout, group flags, editors, transfer runtime, agent processes, search index (unless `searchPersist`), dictation state.

## Commands

- `npm run setup`: first-time setup (Electron + node-pty prebuilt). Never `npm rebuild` node-pty.
- `npm run dev` / `build` / `preview`: electron-vite modes.
- `npm run typecheck`: required correctness gate. `npm run lint`, `npm run format` / `format:check`.
- `npm run test`: all `*.test.ts` via tsx. `npm run test:grid`: grid-spec validation.
- `node scripts/smoke.cjs`: node-pty/ssh2 smoke test. `electron . --self-test`: headless self-test (90s watchdog).
- `npm run build:win` / `build:linux`: installers into `dist/`. `release:win` / `release:linux` also publish.
- Release flow: typecheck + lint + test + smoke → build → commit to `main` → push → tag `v<version>` → upload `dist/DevTerm-<version>-setup.exe` + `.blockmap` + `latest.yml` (clobber).

## Packaging

Version = `package.json` `version` (currently `1.3.0`). electron-builder: `appId com.devterm.app`, `productName DevTerm`, NSIS x64 (`oneClick: false`, `perMachine: false`), unsigned (`verifyUpdateCodeSignature: false`), `asarUnpack` for node-pty and `ort/*.wasm`, `npmRebuild: false`, GitHub publish provider `AEmad99/devterm`.

## Critical Rules

- Keep terminals mounted: hide with `.term-hidden`; never unmount `TerminalLayout` or reparent xterm DOM slots (destroys PTYs/SSH shells).
- Never rebuild node-pty locally; keep node-pty and `ort/*.wasm` `asarUnpack`ed.
- Add IPC through shared types (`IPC` + `DevTermApi`), main handler, and preload exposure together.
- One SSH client per session for shell/SFTP/watch/exec/forwards/git/agent tools — never open hidden duplicate connections.
- Preserve OSC 7 cwd tracking and OSC 133 prompt markers for local and remote shells.
- Use `FsApi.watch()` for live listings; no manual refresh as a primary path.
- Respect the MCP policy boundary in new tools; approval rules pre-check overrides the mode for allow/deny.
- Agent terminal output is user-facing data, not app state; don't kill the agent PTY on its own exit.
- Settings persist to renderer `localStorage`, not `userData`; export/import bundles strip secrets and merge.
- Transfers do not resume mid-file across restarts.
- Use theme CSS variables; keep motion out of the xterm viewport and behind reduced-motion guards.
- Keep the BrowserWindow normal/framed; Windows owns snapping — no custom window controls.
- Commit directly to `main` unless the user asks for a branch or PR.
