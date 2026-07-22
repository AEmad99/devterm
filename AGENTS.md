# AGENTS.md

Guidance for coding agents working in the DevTerm repository.

DevTerm is an Electron 29 desktop terminal: local shells (prebuilt node-pty), SSH/SFTP sessions, workspaces, file browsing/editing (CodeMirror 6), an in-app browser, snippets, a Warp-style Git panel, a persistent transfer queue, offline Whisper dictation, global terminal search, and an embedded multi-provider **DevTerm Agent** with seven external CLI fallbacks (`pi`, `claude`, `opencode`, `kimi`, `grok`, `codex`, `antigravity`). Every agent runs in a local PTY and reaches the remote host only through DevTerm's in-process MCP bridge. Stack: electron-vite, TypeScript strict, React 18, Zustand, xterm.js, ssh2, marked + DOMPurify, `@huggingface/transformers`, `@earendil-works/pi-coding-agent` (bundled runtime), dedicated `node` binary for the agent, electron-updater, zod.

**Current version:** `package.json` → `1.3.9`. Top-level views: **Terminals** (always-mounted workspace: group tabs, split panes, local/remote/browser sessions), **Connections**, **Workspaces**, **Snippets**. DevTerm is a normal framed desktop app; the first screen is the terminal, not a marketing page.

## Architecture

| Layer | Path | Role |
| --- | --- | --- |
| Main | `src/main` | BrowserWindow, IPC handlers, node-pty, SSH/SFTP, port forwards, fs, transfers, MCP bridge, git, search index, updater, persistence |
| Preload | `src/preload/index.ts` | Only typed bridge to the sandboxed renderer (`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`) |
| Renderer | `src/renderer` | React UI, Zustand stores, xterm, CodeMirror, browser panes, dictation worker |
| Shared | `src/shared/types.ts` | `IPC` channel map, `DevTermApi`, domain types |

Every renderer→main capability must be added in **all three places** together: `src/shared/types.ts` (`IPC` + `DevTermApi`), a main IPC handler, and the preload exposure. Streaming channels use the per-id suffix convention and the coalescer in `src/main/ipc/coalesce.ts`.

### Code map (high traffic)

| Area | Location |
| --- | --- |
| App / window | `src/main/index.ts` |
| IPC registration | `src/main/ipc/*` (`foundation.ts` for settings sync / bridge activity) |
| Local PTY | `src/main/pty/manager.ts` |
| SSH / SFTP / reconnect / detached shells | `src/main/ssh/*` (incl. `quick-connect.ts`) |
| Port forwards (`-L`, SOCKS `-D`) | `src/main/ssh/port-forward.ts`, UI `PortForwardPanel.tsx` |
| MCP server / tools / policy | `src/main/mcp/server.ts`, `tools.ts`, `policy.ts` |
| Agent launch (bundled + fallbacks) | `src/main/agent/launch.ts`, `*-launch.ts`, `context.ts`, `extension.ts` |
| Approval rules & activity | `src/main/agent/approval-rules.ts`, `bridge-activity.ts` |
| Search index | `src/main/search/*` (ANSI strip at ingest) |
| Git | `src/main/git/*`, UI `src/renderer/components/git/*` |
| Transfers | `src/main/transfers/*` (persistent queue; `transfer.ts` is self-test helper) |
| Layout / sessions / settings | `src/renderer/store/{layout,sessions,settings}.ts` |
| Terminal chrome | `TerminalLayout.tsx`, `TerminalView.tsx`, `RemoteSessionView.tsx`, `BrowserPane.tsx` |
| Styles | `styles.css` imports `styles/{base,chrome,terminal,panels,motion}.css` |
| Themes / hotkeys | `lib/themes.ts`, `lib/hotkeys.ts` (user-overridable) |

## Feature notes

Non-obvious behavior and code locations. Prefer reading the code for edge cases; keep this file as a durable map, not a changelog dump.

### Terminals & layout

- Tiling model: binary split tree in `src/renderer/store/layout.ts`; `TerminalLayout.tsx` computes rects and renders one stable `.term-slot` per session. Inactive groups stay mounted, hidden via `.term-hidden` (visibility + off-screen translate, **never** `display:none`).
- Focus mode (`focusedId`, Ctrl/Cmd+Shift+Z) and zen mode (`zenMode`, Ctrl/Cmd+Alt+Z) only reposition/hide — never reparent xterm, never scale terminal text (blurs).
- Terminal grids: `CreateGridModal.tsx` + `lib/createGrid.ts` (max 4×4), restored via the shared `restoreGroup` path. Remote grid cells each get their own ssh2 client. Groups launched from workspaces carry `launchedFromWorkspaceId` in `groupFlags` for "Save back".
- Local PTYs: `src/main/pty/manager.ts` picks the shell from the `defaultShell` pref (`auto` / `pwsh` / `powershell` / `cmd` / `custom`) and injects PowerShell OSC 7/133 prompt hooks (explicit shell args bypass injection). A fresh PTY exiting with no output fires `pty:startup-failure:<id>` with a targeted diagnostic.
- Remote SSH: **one ssh2 client per session** (`src/main/ssh/manager.ts`) shared by shell, SFTP, exec, watch polling, port forwards, git ops, and agent tools. Direct hops set `setNoDelay(true)` — keep it. Single bastion hop via `profile.jump`. TOFU host keys in `userData/known_hosts.json` (mode 0o600; mismatches rejected). Auto-reconnect with exponential backoff; session ids stay stable across reconnects.
- Remote shells get OSC 7 (`__dt7`) and OSC 133 (`__dtA`/`__dtB`) hooks (idempotent bash/zsh wraps; PowerShell prompt fn on Windows remotes). Preserve when editing shell setup.
- `remoteDetachedSessions` (default **on**): on POSIX remotes with tmux, shells attach to a stable `tmux new-session -A -s devterm-<sessionId>` session so work survives transport drops. Fallback is a normal shell when tmux is missing; SSH reconnect still restores the human shell channel either way.
- `exec` timeouts resolve `timedOut: true` with partial output — not a disconnect. Port forwarding: local `-L` and dynamic `-D` SOCKS5 (no-auth, CONNECT only) in `port-forward.ts` / `PortForwardPanel.tsx`.
- Tab labels compress long agent/shell activity (`lib/tab-label.ts`); busy tabs are width-capped. One-time welcome hint (Getting started) surfaces real keybindings for palette / new terminal / settings; dismiss is sticky and not resurrected by settings import.

### Files & editor

- `FileExplorer` follows the active shell cwd: local via fs IPC, remote via SFTP on the same ssh2 client. Shared `FsApi` abstraction in `src/renderer/lib/fsapi.ts`.
- Listings live-update via `FsApi.watch()` (local `src/main/fs/watch.ts`; remote SFTP poll at 2500ms). Do not add manual refresh as the primary path.
- Editor: CodeMirror 6 (`EditorView.tsx`), max 5 MiB (`MAX_EDIT_BYTES`), original EOL re-applied on save; sanitized Markdown preview in `lib/markdown-preview.ts` (marked GFM + DOMPurify). Opening a file must keep the Terminals/file tab strip so users can leave the editor.
- Dual-pane SFTP browser uses the **persistent transfer queue** (legacy ad-hoc transfer IPC is gone from the renderer).

### Browser panes

- `<webview>` tabs on partition `persist:browser`, hardened in `src/main/index.ts` + `src/main/ipc/browser.ts`: preload stripped, `nodeIntegration: false`, http(s)/about:blank only (other schemes go to the OS browser), sensitive permissions default-denied, UA de-Electroned.
- Per-origin zoom persisted (`userData/browser-zoom.json`); downloads to `userData/Downloads` with throttled progress broadcast (~150ms). Browser panes are sessions (groups/tabs/splits/focus) but create no PTY or SSH channel.

### Agent bridge (DevTerm Agent + fallbacks)

**Product default:** `agentKind: 'devterm'` — the bundled multi-provider agent (`@earendil-works/pi-coding-agent` + packaged `node` binary), not an external CLI. External CLIs remain selectable fallbacks.

Launch layers:

| Kind | Prep | How it reaches MCP |
| --- | --- | --- |
| `devterm` | `prepareBuiltinAgentLaunch` in `launch.ts` | Bundled Node + CLI + `devterm-mcp.mjs` extension; `--no-builtin-tools`, discovery of user extensions/skills/templates/themes disabled |
| `pi` | `prepareAgentLaunch` | PATH `pi` + same extension isolation flags |
| `claude` | `claude-launch.ts` | Native MCP via `--mcp-config`; keeps local Read/Write/Edit for scratch |
| `opencode` | `opencode-launch.ts` | Per-session `opencode.json` remote MCP entry; tools as `devterm_*` |
| `kimi` | `kimi-launch.ts` | Per-session `.kimi-code/mcp.json`; tools as `mcp__devterm__*` |
| `grok` | `grok-launch.ts` | Per-session `.grok/config.toml` HTTP MCP; tools as `devterm__*` |
| `codex` | `codex-launch.ts` | Isolated `CODEX_HOME/config.toml` HTTP MCP; tools as `mcp__devterm__*` |

Bridge & tools:

- MCP bridge (`src/main/mcp/server.ts`) on `127.0.0.1:<random-port>` gated by a random bearer token.
- Tools (`src/main/mcp/tools.ts`): `ping`, `get_host_context`, `run_command`, `list_dir`, `read_file`, `write_file`. Relative paths and `run_command` honor the operator's live POSIX cwd from OSC 7; Windows remotes keep login-default semantics for cwd prefixing.
- Policy modes `read_only` / `confirm` / `full` in `policy.ts`. Approval rules (`approval-rules.ts`, `userData/approval-rules.json`) are a **PRE-CHECK**: explicit allow/deny short-circuits the mode; `ask` falls through. UI for rules lives under Settings → Agent guardrails.
- Built-in local fs/shell tools are disabled for every agent so host work crosses the bridge over the session's shared ssh2 client (Claude keeps Read/Write/Edit for **local** scratch only).
- Bridge status over `agent:bridge-status:<id>`; MCP `notifications/message` heartbeat every 25s; renderer pushes live cwd via `agent:set-cwd`; confirmations (`agent:confirm`) time out after 120s as `'timeout'`.
- Agent PTY is **not** killed on its own exit — bridge + temp dir stay up for auto-restart after SSH reconnect; cleaned up only on explicit close. Activity log: `bridge-activity.ts` → `AgentActivityPanel.tsx` (filterable, exportable JSONL).
- Briefings: `src/main/agent/context.ts` writes per-session `AGENTS.md` (host facts, air-gap rules, tool map).

**DevTerm Agent settings (1.3.4):**

- Provider / model preferences, ordered rate-limit fallbacks (`fallbackModels` as `provider/model` pairs), and resume toggle live in Settings → DevTerm Agent (`agentPreferences` in `store/settings.ts`).
- Credentials never cross DevTerm IPC: OAuth/API keys stay in Pi's auth store (`~/.pi/agent/auth.json`) or process env; `agent:capabilities` reports runtime version, model catalog, and authenticated-provider **presence** only.
- On HTTP 408 / 429 / 5xx, the MCP extension (`extension.ts` → `registerModelFailover`) switches the next request to the next authenticated fallback.
- Resumable conversations: when `resumeSessions` is on, launch uses `--session-dir <userData>/agent-sessions --session-id <remote-session-id>`; otherwise `--no-session`.
- Instruction-only skill files can be allowlisted with a SHA-256 pin (`trustedSkills`); digest is re-checked at every launch. Executable third-party extensions remain disabled.
- Packaging: `electron-builder.yml` `asarUnpack`s `node/bin`, `@earendil-works/**`, and the agent's dependency closure so the external Node process can resolve modules outside `app.asar`.
- Local performance telemetry: on-demand `performance:snapshot` IPC (`src/main/ipc/performance.ts`); Settings → Performance polls ~3s; nothing is sampled in the background or uploaded.
- Attention signals (`lib/attention.ts`) are agent-oriented: Web Audio chime, OS notification + taskbar flash, tab badge, idle-after-burst detector.

### Search, history, palette

- Global search (`src/main/search/index.ts`): in-memory, 2000 lines/session, fed by local PTY **and** remote SSH output; ANSI/VT/C0 stripped at ingest so the modal shows plain text. Modal: Ctrl/Cmd+Alt+F.
- Optional persistent search tail: `settings.searchPersist` → `userData/search/<sessionId>.jsonl` (FIFO cap).
- Command palette (Ctrl/Cmd+K): fuzzy + frecency; categories Actions / Snippets / Connections / Workspaces / History. History merges DevTerm records with host shell-history files; PSReadLine multi-line (trailing-backtick) continuations are reassembled and multi-line junk is excluded from the palette rather than mangled.
- Snippets (`userData/snippets.json`) support `{{placeholders}}`.

### Git, transfers, dictation, workspaces

- Git panel (`components/git/*`, logic `src/main/git.ts`): full read + write (stale "read-only" comments elsewhere are wrong). Remote ops reuse the session's exec channel; `onChange` polls every 5s; writes invalidate the status cache. VS Code–style graph in `GitGraphView.tsx`. Destructive actions use shared `ConfirmDialog` (not `window.confirm`).
- Persistent transfer queue (`src/main/transfers/*`, `userData/transfers.json`): concurrency 2, survives restarts, no mid-file resume (interrupted items marked canceled; users retry). Progress events are coalesced; `selectVisible` is last-24h and must stay referentially stable for Zustand (use `useShallow`).
- Voice dictation: renderer-only Whisper (`src/renderer/lib/stt/*`), WebGPU→WASM fallback, push-to-talk (Ctrl/Cmd+Shift+M), models cached in `persist:browser`; `ort/*.wasm` must stay `asarUnpack`ed. Worker crash recovery discards stale ready messages.
- Workspaces (`userData/workspaces.json`): capture / launch / rename / duplicate / `autoLaunch` on boot (all flagged workspaces open in their own groups). Ad-hoc SSH sessions without a saved `connectionId` are skipped on capture.
- QuickConnect (`userData/quick-connect.json`): MRU `host:port:user` triples (cap 20) drive the host datalist in `ConnectionForm`. Known-hosts management UI lives under Connections.

### Settings, theme, window

- Settings live in `src/renderer/store/settings.ts`, persist to renderer `localStorage` (`devterm.settings.v1`), mirrored to `userData/settings.json` via `settings:sync`. Export/import (`src/main/settings-io.ts`) strips secrets and always merges through the same normalizers as load.
- One theme drives chrome + xterm palette via CSS variables (`lib/themes.ts`, split CSS under `styles/`) — use variables / `color-mix`, not hardcoded colors. Prefer tokens like `--danger`, `--ok`, `--font-mono`, `--font-ui`. Motion is CSS-only and behind `prefers-reduced-motion` guards; never animate/scale the xterm viewport.
- Keybindings: ids in `lib/hotkeys.ts`, user-overridable; App focus guards avoid firing most shortcuts while typing in an editor.
- Window: normal framed opaque BrowserWindow — Windows owns snapping/titlebar; never add custom snap or fake window controls. Key flags: `backgroundThrottling: false`, `webviewTag: true`, `autoHideMenuBar`, caches pinned into `userData`, top frame navigation-locked, `appUserModelId com.devterm.app`.
- Auto-update: `src/main/updater.ts` (electron-updater, GitHub `AEmad99/devterm`, unsigned builds, skipped in dev/self-test).
- Shared UI helpers: `ConfirmDialog`, `useEscapeKey`, `formatBytes`, `ModalShell` a11y (`role="dialog"`, `aria-modal`, `aria-labelledby`). Pane tabs use `role="tablist"` / `role="tab"`.

## Persistence

| Store | Contents |
| --- | --- |
| `userData/connections.json` | Saved SSH profiles; secret fields safeStorage-encrypted (incl. bastion `jump`) |
| `userData/workspaces.json` | Workspace snapshots (no secrets) |
| `userData/snippets.json` | Command snippets |
| `userData/approval-rules.json` | Agent allow/deny/ask rules |
| `userData/known_hosts.json` | TOFU host keys (mode 0o600) |
| `userData/transfers.json` | Persistent transfer queue |
| `userData/browser-zoom.json` | Per-origin webview zoom |
| `userData/bridge-activity.jsonl` | Agent bridge activity log |
| `userData/settings.json` | Settings mirror from renderer |
| `userData/agent-sessions/` | Optional resumable DevTerm Agent transcripts |
| `userData/search/<sessionId>.jsonl` | Optional persistent search tail |
| `userData/quick-connect.json` | MRU host triples |
| `userData/Downloads/` | Browser downloads |
| Renderer `localStorage` `devterm.settings.v1` | Full settings (no secrets) |

**In-memory only:** sessions, layout, group flags, editors, transfer runtime, agent processes, search index (unless `searchPersist`), dictation state.

## Commands

- `npm run setup`: first-time setup (Electron + node-pty prebuilt). **Never** `npm rebuild` node-pty. Prefer `npm install --ignore-scripts` then `setup`.
- `npm run dev` / `build` / `preview`: electron-vite modes.
- `npm run typecheck`: required correctness gate (node + web tsconfigs).
- `npm run lint`, `npm run format` / `format:check`.
- `npm run test`: all `*.test.ts` via tsx. `npm run test:grid`: grid-spec validation.
- `node scripts/smoke.cjs`: node-pty/ssh2 smoke test. `electron . --self-test`: headless self-test (90s watchdog).
- `npm run build:win` / `build:linux`: installers into `dist/`. `release:win` / `release:linux` also publish via electron-builder.
- **Release flow:** typecheck + lint + test + smoke → `build:win` → commit to `main` → push → tag `v<version>` → upload `dist/DevTerm-<version>-setup.exe` + `.blockmap` + `latest.yml` (clobber). Builds are unsigned (`CSC_IDENTITY_AUTO_DISCOVERY=false` if packaging hits winCodeSign symlink issues on Windows).

## Packaging

- Version = `package.json` `version` (currently **1.3.7**).
- electron-builder: `appId com.devterm.app`, `productName DevTerm`, NSIS x64 (`oneClick: false`, `perMachine: false`, `allowToChangeInstallationDirectory: true`), unsigned (`verifyUpdateCodeSignature: false`), `npmRebuild: false`, GitHub publish provider `AEmad99/devterm`.
- NSIS reinstall close logic: `resources/installer.nsh` (`nsis.include`) — `customInit` + `customCheckAppRunning` force-kill install-dir processes (required because elevated UAC inner installs skip stock `CHECK_APP_RUNNING`); `customUnInstallCheck*` lets upgrades continue if the old uninstaller fails.
- `asarUnpack` must include: `node-pty`, `ort/*.wasm`, bundled agent Node binary (`node/bin/**`), `@earendil-works/**`, and the listed agent runtime dependency packages in `electron-builder.yml`. Do not drop those entries or the built-in agent fails to start from the installed app.

## Critical rules

- Keep terminals mounted: hide with `.term-hidden`; never unmount `TerminalLayout` or reparent xterm DOM slots (destroys PTYs/SSH shells).
- Never rebuild node-pty locally; keep node-pty, `ort/*.wasm`, and the bundled agent runtime `asarUnpack`ed.
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
- Credentials for model providers never travel over DevTerm IPC; only capability/auth presence is exposed.
- Commit directly to `main` unless the user asks for a branch or PR.

## Recent release notes (for context)

- **1.3.9** — Google Antigravity CLI (`agy`) support: binary resolution, per-session `.antigravity/mcp.json` HTTP MCP bridge config, host briefings, and UI fallback options.
- **1.3.7** — Installer never treats `*setup*` as the app; safe-root wipe before extract; temp PS unlock script.
- **1.3.6** — Installer elevated/UAC fix: unlock runs in `customInit` on the elevated inner process; old-uninstall failures no longer abort upgrade.
- **1.3.5** — Windows installer reinstall: force-close DevTerm + install-dir orphans (agent node.exe); quit tree-kills local PTYs.
- **1.3.4** — Deep reliability pass: git live status, SOCKS5 handshake, SSH reconnect/forwards/watches, PTY id-reuse, transfer cancel/flush, MCP agent cleanup, packaging size exclusions, TOFU confirm dialog.
- **1.3.3** — Bundled multi-provider DevTerm Agent (default), provider/model routing + rate-limit fallbacks, resumable agent sessions, SHA-256 pinned skills, Settings performance snapshot, packaging unpack for agent Node runtime, remote detached tmux sessions setting.
- **1.3.2** — PSReadLine multi-line history fix, ANSI-stripped global search, React #185 Zustand/`useShallow` fixes, welcome hint, ConfirmDialog/useEscapeKey, a11y polish.
- **1.3.1** — STT worker crash recovery, download/transfer flicker fixes, layout/session guards, hotkey fixes.
- **1.3.0** — Full settings sync, agent guardrails UI, known-hosts panel, remote SSH search index, SOCKS `-D`, persistent search tail, QuickConnect, agent activity export, workspace auto-launch, SftpBrowser on persistent queue.

When behavior and this file disagree, **trust the code** and update this file in the same change.
