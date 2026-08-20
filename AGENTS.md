# AGENTS.md

Guidance for coding agents working in the DevTerm repository.

DevTerm is an Electron 29 desktop terminal: local shells (prebuilt node-pty), SSH/SFTP sessions, workspaces, file browsing/editing (CodeMirror 6), an in-app browser, snippets, a Warp-style Git panel, a persistent transfer queue, offline Whisper dictation, global terminal search, and an embedded multi-provider **DevTerm Agent** with seven external CLI fallbacks (`pi`, `claude`, `opencode`, `kimi`, `grok`, `codex`, `antigravity`). Every agent runs in a local PTY and reaches the remote host only through DevTerm's in-process MCP bridge. Stack: electron-vite, TypeScript strict, React 18, Zustand, xterm.js, ssh2, marked + DOMPurify, `@huggingface/transformers`, `@earendil-works/pi-coding-agent` (bundled runtime), dedicated `node` binary for the agent, electron-updater, zod.

**Current version:** `package.json` → `1.3.17`. Top-level views: **Terminals** (always-mounted workspace: group tabs, split panes, local/remote/browser sessions), **Connections**, **Workspaces**, **Snippets**. DevTerm is a normal framed desktop app; the first screen is the terminal, not a marketing page.

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
| Agent UI modes / ask strip | `lib/agent-ui.ts`, `AgentAskBar.tsx`, `AgentPane.tsx`, `agent-window.tsx`, main `ipc/agent.ts` + `ipc/broadcast.ts` |
| Approval rules & activity | `src/main/agent/approval-rules.ts`, `bridge-activity.ts` |
| Search index | `src/main/search/*` (ANSI strip at ingest) |
| Git | `src/main/git/*`, UI `src/renderer/components/git/*` |
| Transfers | `src/main/transfers/*` (persistent queue; `transfer.ts` is self-test helper) |
| Session restore | `lib/session-restore.ts`, `main/ipc/session-restore.ts` |
| SSH config import | `main/ssh/ssh-config-parse.ts`, Connections “Import SSH config” |
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
- Remote shells get OSC 7 (`__dt7`) and OSC 133 (`__dtA`/`__dtB`) hooks (idempotent bash/zsh wraps; PowerShell prompt fn on Windows remotes). Inside tmux, hooks emit DCS-wrapped OSC (`\ePtmux;…`) and DevTerm enables `allow-passthrough` so cwd still reaches the explorer. Preserve when editing shell setup (`buildPosixShellIntegrationSetup`).
- `remoteDetachedSessions` (default **on**): on POSIX remotes with a *working* tmux (`tmux -V`, not just `command -v`), connecting offers a pane-local picker (`TmuxPicker` + `ssh.listTmux` / `ssh.attachTmux` / `ssh.killTmux`) — live pane preview, window/command/cwd metadata, create-and-attach, kill session, or a normal login shell. Reopen anytime from the remote tab-strip button, Ctrl/Cmd+Alt+T, or the command palette. Attach is a child process, **never** `exec`, so prefix+d returns to the login shell instead of killing the SSH channel. Switching sessions while already attached uses `tmux switch-client` (exec), not typed attach. If a tmux client still exits (`exec tmux` leftovers), main reopens a normal shell without firing `ssh:exit`. Broken tmux installs skip the picker. SSH reconnect re-attaches only when the operator was still inside the chosen session. Remote POSIX shell-integration inject is echo-off + no `clear` so the login banner is not flashed/wiped.
- Remote POSIX OSC inject (`buildPosixShellIntegrationSetup`): write via `writeQuiet` (`stty -echo` as its own line, then payload). Never `clear`. Do not type the setup into an existing tmux pane (only into a freshly created session). Preserve OSC 7/133 DCS wrapping when editing.
- `exec` timeouts resolve `timedOut: true` with partial output — not a disconnect. Port forwarding: local `-L` and dynamic `-D` SOCKS5 (no-auth, CONNECT only) in `port-forward.ts` / `PortForwardPanel.tsx`.
- Tab labels compress long agent/shell activity (`lib/tab-label.ts`); busy tabs are width-capped. One-time welcome hint (Getting started) surfaces real keybindings for palette / new terminal / settings; dismiss is sticky and not resurrected by settings import.
- **Renderer:** terminals use the **canvas** addon on purpose (`lib/renderer.ts`) — WebGL is avoided because every session stays mounted and Chromium's WebGL context cap (~16) blanked panes. Fall back is xterm DOM. Do not switch to WebGL without a context-budget strategy.
- **Autosuggest:** history-driven popup (`lib/autosuggest.ts` + `Autosuggest.tsx`) uses OSC 133 `;B` as the command-input anchor; accepting sends keystrokes to the shell (never writes into the buffer). Requires working prompt hooks.
- **Find:** per-pane SearchAddon bar via `SearchBar`; opened from xterm key handler **and** App global hotkey through `openTerminalFind` / `registerFindOpener` in `lib/terms.ts`.

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
| `antigravity` | `antigravity-launch.ts` | Per-session `.antigravity/mcp.json` HTTP MCP for Google `agy` / Antigravity CLI |

Bridge & tools:

- MCP bridge (`src/main/mcp/server.ts`) on `127.0.0.1:<random-port>` gated by a random bearer token.
- Tools (`src/main/mcp/tools.ts`): `ping`, `get_host_context`, `run_command`, `list_dir`, `read_file`, `write_file`. Relative paths and `run_command` honor the operator's live POSIX cwd from OSC 7; Windows remotes keep login-default semantics for cwd prefixing.
- Policy modes `read_only` / `confirm` / `full` in `policy.ts`. Approval rules (`approval-rules.ts`, `userData/approval-rules.json`) are a **PRE-CHECK**: explicit allow/deny short-circuits the mode; `ask` falls through. UI for rules lives under Settings → Agent guardrails.
- Built-in local fs/shell tools are disabled for every agent so host work crosses the bridge over the session's shared ssh2 client (Claude keeps Read/Write/Edit for **local** scratch only).
- Bridge status over `agent:bridge-status:<id>`; MCP `notifications/message` heartbeat every 25s; renderer pushes live cwd via `agent:set-cwd`; confirmations (`agent:confirm`) time out after 120s as `'timeout'`. Confirms and PTY data are **broadcast** to every `BrowserWindow` so a floating agent window can approve and stream.
- Agent PTY is **not** killed on its own exit — bridge + temp dir stay up for auto-restart after SSH reconnect; cleaned up only on explicit **Stop** / session close / quit. Activity log: `bridge-activity.ts` → `AgentActivityPanel.tsx` (filterable, exportable JSONL).
- Briefings: `src/main/agent/context.ts` writes per-session `AGENTS.md` (host facts, air-gap rules, tool map).

**Agent UI modes (1.3.15+):** process lifetime ≠ UI placement.

| Mode | UX |
| --- | --- |
| `docked` | Side column beside the remote shell (classic layout) |
| `hidden` | Full terminal estate; process keeps running; chip shows mode + last task |
| `floating` | Separate OS `BrowserWindow` (`agent-window.html`) — multi-monitor |

- Store fields: `session.agentUiMode` / `agentPtyId` / `agentPolicyMode` (`store/sessions.setAgentUi`). Main tracks mode via `agent:set-ui-mode` and broadcasts `agent:ui-mode-changed` so the main window store stays in sync when the float window docks/hides.
- `agent:open` is **idempotent** unless `forceRestart` (Restart button). Mode switches reattach; they must not kill the agent.
- Main window keeps a **stashed** `AgentPane` (`.agent-ui-stash` + `.term-hidden`) while the agent is alive so scrollback survives hide/float; only the **active** surface sends input/resize and attention chimes.
- **Ask bar** under every remote shell (`AgentAskBar`): ensure agent → inject prompt into the live agent PTY (Ctrl+Enter). Starts docked if the agent was fully stopped.
- Floating window controls: Dock / Hide / Stop; OS close (X) demotes to `hidden` without killing the process. Closing the remote tab calls `agent.close` + `agent.closeWindow`.
- Helpers: `lib/agent-ui.ts` (`ensureAgent`, `stopAgent`, `injectAgentPrompt`, `setAgentUiMode`). Renderer entry: `agent-window.html` + `agent-window.tsx` (electron-vite multi-page input).

**DevTerm Agent settings (since 1.3.3+):**

- Provider / model preferences, ordered rate-limit fallbacks (`fallbackModels` as `provider/model` pairs), and resume toggle live in Settings → DevTerm Agent (`agentPreferences` in `store/settings.ts`).
- Credentials never cross DevTerm IPC: OAuth/API keys stay in Pi's auth store (`~/.pi/agent/auth.json`) or process env; `agent:capabilities` reports runtime version, model catalog, and authenticated-provider **presence** only.
- On HTTP 408 / 429 / 5xx, the MCP extension (`extension.ts` → `registerModelFailover`) switches the next request to the next authenticated fallback.
- Resumable conversations: when `resumeSessions` is on, launch uses `--session-dir <userData>/agent-sessions --session-id <stable-id>`; `deriveAgentSessionId()` keys by saved connection id or `user@host:port` so transcripts survive tab close/reopen (1.3.11). Otherwise `--no-session`.
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

- Git panel (`components/git/*`, logic `src/main/git/index.ts`): **full read + write** (stage/unstage/commit/push/pull/branch/stash/tag/remote). A stale "Git awareness (read-only)" comment in `src/shared/types.ts` is wrong — do not re-introduce read-only product framing. Remote ops reuse the session's exec channel; `onChange` polls every 5s; writes invalidate the status cache. VS Code–style graph in `GitGraphView.tsx`. Destructive actions use shared `ConfirmDialog` (not `window.confirm`).
- Persistent transfer queue (`src/main/transfers/*`, `userData/transfers.json`): concurrency 2, survives restarts, no mid-file resume (interrupted items marked canceled; users retry). Progress events are coalesced; `selectVisible` is last-24h and must stay referentially stable for Zustand (use `useShallow`).
- Voice dictation: renderer-only Whisper (`src/renderer/lib/stt/*`), WebGPU→WASM fallback, push-to-talk (Ctrl/Cmd+Shift+M), models cached in `persist:browser`; `ort/*.wasm` must stay `asarUnpack`ed. Worker crash recovery discards stale ready messages.
- Workspaces (`userData/workspaces.json`): capture / launch / rename / duplicate / `autoLaunch` on boot (all flagged workspaces open in their own groups). Ad-hoc SSH sessions without a saved `connectionId` are skipped on capture.
- **Session restore** (`settings.sessionRestore`, default on): debounced snapshot of groups → `userData/session-restore.json` via `sessionRestore.*` IPC; boot order is auto-launch workspaces → restore snapshot → empty local. Restores local shells + saved SSH only (not browsers / ad-hoc SSH / agents). Code: `lib/session-restore.ts`, `main/ipc/session-restore.ts`.
- **SSH config import:** Connections → “Import SSH config” parses `~/.ssh/config` (`main/ssh/ssh-config-parse.ts`); concrete Hosts only; merges Host * defaults; skips duplicates; no passwords.
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
| `userData/session-restore.json` | Last-session groups/layout snapshot (no secrets) |
| `userData/Downloads/` | Browser downloads |
| Renderer `localStorage` `devterm.settings.v1` | Full settings (no secrets) |

**In-memory only:** live sessions/layout (mirrored to session-restore when enabled), group flags, editors, transfer runtime, agent processes, search index (unless `searchPersist`), dictation state.

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

- Version = `package.json` `version` (currently **1.3.17**).
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
- Agent **process lifetime ≠ UI mode**: hide/float/dock must not call `agent.close`; only explicit Stop / session close / quit. Keep `agent:open` idempotent unless `forceRestart`.
- Settings persist to renderer `localStorage`, not `userData`; export/import bundles strip secrets and merge.
- Transfers do not resume mid-file across restarts.
- Use theme CSS variables; keep motion out of the xterm viewport and behind reduced-motion guards.
- Keep the BrowserWindow normal/framed; Windows owns snapping — no custom window controls.
- Credentials for model providers never travel over DevTerm IPC; only capability/auth presence is exposed.
- Commit directly to `main` unless the user asks for a branch or PR.

## Recent release notes (for context)

- **1.3.17** — Richer tmux picker (live pane preview, window/command/cwd, kill session); reopen via pane button / Ctrl+Alt+T / palette; attach-while-inside uses `switch-client`; remote shell-integration inject no longer echoes a wall of script then `clear`s the login banner.
- **1.3.16** — Fix stray `]` around remote bash prompts (detached tmux): the OS-integration prompt markers now reference `${__dtA}`/`${__dtB}` deferred in PS1 instead of baking the tmux DCS envelope bytes in, which let bash's `\]` decoder print a literal bracket. Regression-tested in `detached-session.test.ts`.
- **1.3.15** — Agent UI modes (`docked` / `floating` / `hidden`) with process lifetime decoupled from layout; Warp-style **Ask agent** strip under remote shells (ensure + inject into live agent PTY); floating agent OS window (multi-monitor) with dock/hide/stop and cross-window confirm routing; session-restore MVP (last groups/local/saved-SSH); `~/.ssh/config` import; global Find hotkey wired through `openTerminalFind`; default scrollback raised to 10 000; multi-window PTY/bridge broadcast for pop-out agent.
- **1.3.14** — Settings modal scrolling fix (issue #4): the dialog's grid row now tracks its own height (`grid-template-rows: minmax(0, 1fr)`) with `min-height: 0` guards on both columns, so long tabs scroll inside `.settings-content-body` instead of overflowing and getting clipped by `overflow: hidden`. Sidebar nav regrouped into labeled sections with per-tab subtitles; new-tab picker restyled as list rows; terminal context menu gains a clipboard/selection separator; pane tab-strip nav arrows hidden when the strip is collapsed.
- **1.3.13** — Remote detached sessions: probe `tmux -V` before `exec` so hosts with a broken tmux install (e.g. missing `libncurses.so.5`) fall back to a normal shell instead of killing the SSH channel.
- **1.3.12** — Terminal host padding fix: moved xterm padding to inner `.xterm` element so `FitAddon` accurately calculates row height without clipping bottom prompt lines at the status bar.
- **1.3.11** — Persistent remote agent task memory, stable per-connection/per-host session keys across tab opens and app restarts, titlebar badge cleanup, and modal scroll padding overflow fix.
- **1.3.10** — Robust NSIS installer process termination: normalize 8.3 short paths, tree-kill lingering agent processes (node.exe), and override customRemoveFiles to eliminate 'DevTerm can't be closed' prompt during reinstalls/upgrades.
- **1.3.9** — Google Antigravity CLI (`agy`) support: binary resolution, per-session `.antigravity/mcp.json` HTTP MCP bridge config, host briefings, and UI fallback options.
- **1.3.7** — Installer never treats `*setup*` as the app; safe-root wipe before extract; temp PS unlock script.
- **1.3.6** — Installer elevated/UAC fix: unlock runs in `customInit` on the elevated inner process; old-uninstall failures no longer abort upgrade.
- **1.3.5** — Windows installer reinstall: force-close DevTerm + install-dir orphans (agent node.exe); quit tree-kills local PTYs.
- **1.3.4** — Deep reliability pass: git live status, SOCKS5 handshake, SSH reconnect/forwards/watches, PTY id-reuse, transfer cancel/flush, MCP agent cleanup, packaging size exclusions, TOFU confirm dialog.
- **1.3.3** — Bundled multi-provider DevTerm Agent (default), provider/model routing + rate-limit fallbacks, resumable agent sessions, SHA-256 pinned skills, Settings performance snapshot, packaging unpack for agent Node runtime, remote detached tmux sessions setting.
- **1.3.2** — PSReadLine multi-line history fix, ANSI-stripped global search, React #185 Zustand/`useShallow` fixes, welcome hint, ConfirmDialog/useEscapeKey, a11y polish.
- **1.3.1** — STT worker crash recovery, download/transfer flicker fixes, layout/session guards, hotkey fixes.
- **1.3.0** — Full settings sync, agent guardrails UI, known-hosts panel, remote SSH search index, SOCKS `-D`, persistent search tail, QuickConnect, agent activity export, workspace auto-launch, SftpBrowser on persistent queue.

---

## Product inventory (what ships today — v1.3.15)

Snapshot of the **implemented** surface area as of this audit. Use this when prioritizing features so we do not re-build what already exists. Prefer reading the code for edge cases.

### Capability matrix

| Area | Status | Notes / code |
| --- | --- | --- |
| Local shells | **Shipped** | `defaultShell` auto/pwsh/powershell/cmd/custom; ConPTY startup-failure diagnostics; OSC 7/133 PS hooks |
| SSH remote shells | **Shipped** | Password / key / single bastion hop; TOFU; auto-reconnect; TCP_NODELAY; one client/session |
| Detached remote sessions | **Shipped** | tmux picker on connect; attach without `exec`; detach returns to login shell |
| Local session detach/reattach | **Not shipped** | Still planned in `FEATURE-PLANS.md`; PTYs die with the app |
| Session/layout restore on app restart | **Shipped (MVP)** | `sessionRestore` (default on): last-session snapshot in `userData/session-restore.json`; auto-launch workspaces still win; ad-hoc SSH skipped |
| Tiling splits + groups | **Shipped** | Binary split tree, drag tabs, focus + zen modes; always-mounted slots |
| Terminal grids + broadcast | **Shipped** | Up to 4×4 (`CreateGridModal` / `createGrid.ts`); optional initial broadcast command |
| File explorer (cwd-following) | **Shipped** | Local fs + remote SFTP; `FsApi.watch()` live updates |
| Dual-pane SFTP + transfers | **Shipped** | Persistent queue (concurrency 2); no mid-file resume |
| CodeMirror editor | **Shipped** | Multi-language CM6; 5 MiB cap; Markdown edit/side/preview (`MarkdownPreview`) |
| In-app browser | **Shipped** | Hardened `<webview>`, zoom, downloads; **not** agent-scriptable |
| Command palette + snippets | **Shipped** | Ctrl/Cmd+K; `{{placeholders}}`; history + frecency |
| History-driven autosuggest | **Shipped** | OSC 133 ;B anchors + popup (`lib/autosuggest.ts`) |
| Per-pane find | **Shipped** | SearchAddon + `SearchBar`; App hotkey + pane key handler via `openTerminalFind` |
| Global terminal search | **Shipped** | Ctrl/Cmd+Alt+F; 2000 lines/session; optional disk tail |
| Default scrollback | **Shipped** | Default **10 000** lines (clamp 100–100 000) |
| Git panel (Warp-style) | **Shipped** | Full R/W panel + graph; remote via same SSH exec |
| Port forwards | **Shipped** | `-L` and SOCKS5 `-D` |
| Offline Whisper dictation | **Shipped** | Push-to-talk; WebGPU→WASM; models in browser partition |
| Themes / settings export | **Shipped** | 9 themes incl. Glass; full settings sync + import/export (secrets stripped) |
| Bundled DevTerm Agent | **Shipped (default)** | Multi-provider Pi runtime + packaged Node; resume + model failover |
| External agent CLIs | **Shipped** | pi, claude, opencode, kimi, grok, codex, antigravity — all via MCP bridge |
| Agent UI modes | **Shipped** | `docked` / `floating` / `hidden`; process keeps running when hidden/floated |
| Ask-agent strip | **Shipped** | Bottom compose bar on remote shells; inject into live agent PTY |
| Floating agent window | **Shipped** | Separate OS window (`agent-window.html`); dock/hide/stop |
| MCP tools | **Shipped (narrow)** | `ping`, `get_host_context`, `run_command`, `list_dir`, `read_file`, `write_file` only |
| Agent guardrails | **Shipped** | Policy modes + prefix approval rules + activity log/export |
| Attention signals | **Shipped** | Agent-only idle chime, tab badge, OS notify when backgrounded |
| QuickConnect / known hosts UI | **Shipped** | MRU host triples; Connections known-hosts management |
| Workspaces auto-launch | **Shipped** | `autoLaunch` on boot into separate groups |
| Windows installer | **Shipped** | NSIS x64 unsigned; heavy process-kill/unlock work in 1.3.5–1.3.10 |
| Linux packaging | **Shipped (secondary)** | `build:linux` AppImage path; primary QA is Windows |
| macOS packaging | **Not a product focus** | Electron stack can run in dev; no signed macOS release pipeline |
| `~/.ssh/config` import | **Shipped** | Connections → “Import SSH config”; concrete Hosts only; no passwords |
| Multi-hop ProxyJump chain | **Not shipped** | Single `profile.jump` hop only |
| Block-based terminal UI | **Not shipped** | OSC 133 A/B injected; no C/D exit markers → no Warp-style blocks |
| Programmable app CLI / socket API | **Not shipped** | No cmux-style external control surface |
| Inline images / sixel | **Not shipped** | Paste-image saves path to temp file only |
| Auto-update (GitHub) | **Shipped** | electron-updater; unsigned; skipped in dev/self-test |

### Scale (repo)

- ~180 TypeScript/TSX sources under `src/`, ~15 unit tests, ~1600-line `types.ts`.
- Typecheck clean at audit time (`npm run typecheck`).
- Open GitHub issues (AEmad99/devterm): **#1** syntax highlight, **#2** app preview/annotate mode, **#3** markdown preview — **#3 is largely done** in-app (close or re-scope); **#4** settings scroll closed in 1.3.14.

### Doc debt (out of date vs code)

| Doc | Problem |
| --- | --- |
| `OVERVIEW.md` | May still lag multi-provider agent + agent UI modes; prefer this file + code |
| `FEATURE-PLANS.md` (2026-06-25) | Global search + remote tmux + session restore MVP + SSH config import are **implemented**; local detach still open |
| `CHANGELOG.md` | Catch up at release time (keep in the release checklist) |

---

## Known bugs & fix candidates

Ordered roughly by user impact × confidence. These were found by code inspection against v1.3.15; re-verify before fixing.

### Confirmed / high confidence

1. ~~**Find hotkey is focus-gated and App path is a no-op**~~ **Fixed** in 1.3.15 (`openTerminalFind`).

2. **Windows remote agent cwd is intentionally weak**  
   - MCP `run_command` / relative paths only prefix POSIX cwd (`/` paths). Windows remotes stay on login `$HOME` / profile default. Documented in `tools.ts`, but operators on Windows SSH hosts will see "agent ran in the wrong directory" as a bug.  
   - **Fix options:** PowerShell `Set-Location` wrapper when host OS is windows; or force absolute paths in the agent briefing more aggressively.

3. ~~**Live workspace evaporates on quit**~~ **MVP shipped** in 1.3.15. Still missing on restore: browser panes, ad-hoc SSH, open editors, agent panes / UI mode.

4. **Transfers never resume mid-file**  
   - Restart/cancel → canceled; user must retry whole file. Fine for small configs; painful for multi-GB artifacts.  
   - **Fix:** SFTP resume via offset write / `fstat` size check, or document clearly in UI.

5. **Ask-bar prompt inject is best-effort for TUI agents**  
   - Injects text + Enter into the agent PTY after bridge ready; interactive CLIs that are not at an input prompt may ignore or mis-handle it. Structured chat for DevTerm Agent only remains a follow-up.

### Medium confidence / design traps

6. **Mount-everything × renderer cost**  
   - Every session in every group stays mounted (correct for PTY survival). Canvas renderer is deliberate (WebGL context cap). Many groups + grids still burn RAM/CPU; Settings performance snapshot helps diagnose but there is no auto-hibernate of idle groups' xterm buffers.  
   - Default scrollback is 10 000 (clamp 100–100 000). Stashed agent panes while floating add a second xterm subscriber — intentional for scrollback.

7. **Attention is idle-heuristic, not protocol-true**  
   - No OSC 9/99/777 notification parsing (cmux-style); no OSC 133 ;C/;D command-finished markers. Idle-after-burst can false-positive on quiet long jobs or false-negative on agents that print sparingly.  
   - **Fix ladder:** emit/consume OSC 133 C/D → true exit-code badges → optional OSC 9 attention.

8. **Agent MCP tool surface is thin**  
   - No bridge tools for git, port-forward, browser, or search. Agents must shell out via `run_command`, which is policy-noisy and less structured.  
   - Not a runtime bug, but a capability ceiling vs Warp/cmux agent workflows.

9. **Open issue hygiene**  
   - #3 Markdown Preview Mode should be closed or narrowed (preview exists; maybe missing only a dedicated hotkey).  
   - #1 "command syntax highlighting like zsh" is hard in a raw PTY (shell owns the line); set expectations or scope to block UI / input editor.

10. **Electron 29 age**  
    - Chromium security train moves; 29 is behind current Electron majors. Upgrade is a project, not a one-liner (webview, node-pty ABI, asarUnpack). Track as platform risk.

### Test / CI gaps

- Only ~15 `*.test.ts` files; large surfaces (layout DnD, SSH reconnect, agent launch matrix, SFTP queue) rely on self-test + manual QA.  
- `CHANGELOG.md` lag makes support harder — keep it in the release checklist.

---

## Competitive suggestions (Warp, cmux, and peers)

Suggestions are **mapped to DevTerm's existing architecture** (always-mounted tiling, one SSH client, MCP boundary, Windows-first Electron). Steal product ideas, not stack rewrites.

### Priority legend

- **P0** — small code, high daily-driver impact  
- **P1** — differentiates DevTerm as an *agentic SSH workbench*  
- **P2** — larger bets / platform work  

### From Warp (agentic terminal + blocks + workflows)

| Idea | Why it wins | DevTerm fit | Priority |
| --- | --- | --- | --- |
| **Command blocks** (group input+output, copy output only, collapse) | Best single UX leap past raw xterm scrollback | Already inject OSC 133 A/B; add C/D (exit) markers in PS/bash hooks, parse in `TerminalView`, render block chrome **outside** the xterm canvas (overlay), never reparent xterm | **P1** |
| **Workflows** (named multi-step, parameterized, shareable) | Snippets are single-shot; ops runbooks are multi-step | Extend snippets → workflow docs (JSON in userData) + palette runner; optional "send each line / wait for prompt" using OSC 133 | **P1** |
| **Natural-language → shell** (inline, not only full agent pane) | Low-friction vs opening Agent | **Ask bar shipped (1.3.15)**; next: "Explain selection" / "Fix last error" with selection + last block context | **P1 (partial)** |
| **Vertical tabs with git branch / task metadata** | Multitasking at a glance | Extend `tab-label.ts` + StatusBar: branch from git poll, agent task already exists; optional vertical tab strip setting | **P1** |
| **Agent diff review surface** | Warp reviews code changes in-app | Hook git panel + editor: "show agent write_file diff before apply" in `confirm` policy | **P1** |
| **Input editor** (multiline, IDE keys before submit) | Better than fighting readline for long commands | Optional compose box above active pane; submit sends to PTY | **P2** |
| **Parallel multi-agent orchestration UI** | Warp/Oz narrative | DevTerm already runs one agent pane per remote session; add "open second agent" as another tab on same SSH client (bridge already per-session — may need second MCP server id) | **P2** |

### From cmux (native agent multitasking terminal)

| Idea | Why it wins | DevTerm fit | Priority |
| --- | --- | --- | --- |
| **Notification rings / stronger attention chrome** | Operators juggle many agents | Build on `lib/attention.ts`: pane outline CSS when `needsAttention` / `agentPendingApproval`; parse OSC 9/99 if present | **P0** |
| **Full session restore** (windows, panes, cwd, scrollback, agents) | "Quit and continue" | **MVP shipped (1.3.15)** for local + saved SSH groups; still missing browsers / ad-hoc SSH / agents / scrollback | **P0 (partial)** |
| **Tab metadata: ports + cwd + branch** | Situational awareness | Port-forward list + `ss`/`netstat` optional probe is heavy — start with cwd (have it) + git branch (have it) | **P0** |
| **Programmable CLI / socket API** | Agents and scripts drive the app | Optional local IPC/HTTP under bearer token: open session, send keys, read screen text, open browser URL — mirror MCP security model | **P1** |
| **Scriptable browser for agents** | Verify web changes without leaving app | New MCP tools (`browser_navigate`, `browser_snapshot`) gated by policy, driving existing BrowserPane / webview — **do not** expose full Node to the page | **P1** |
| **Subagent → new pane** | Visibility of parallel work | When user/agent requests parallel work, `addLocal`/`connectSsh` sibling tab in same group | **P2** |
| **GPU terminal (Ghostty/libghostty)** | Native perf story | **Do not** chase on Electron Windows path; canvas choice is intentional. Revisit only if leaving Electron (`TAURI-MIGRATION.md`) | **P2 / defer** |

### From Windows Terminal / iTerm2 / Ghostty / WezTerm / Tabby

| Idea | Source | DevTerm fit | Priority |
| --- | --- | --- | --- |
| **Import `~/.ssh/config`** | WT, Tabby, many SSH UIs | **Shipped (1.3.15)** — Connections → Import SSH config | **P0 done** |
| **Raise default scrollback** (10k–50k) + soft cap | All modern terminals | **Default 10k shipped (1.3.15)**; clamp 100–100k | **P0 done** |
| **Shell integration exit codes on tabs** | iTerm2, WT | OSC 133 C/D → `exitCode` badge on tab (field already exists on `Session`) | **P0** |
| **Multi-hop ProxyJump** | OpenSSH | `jump` is single hop; allow `jump[]` chain in profile + connection.ts | **P1** |
| **Profiles** (color/icon per connection) | WT | Connection color → tab accent | **P1** |
| **Hyperlink + path click** | WT, iTerm | WebLinks addon exists; add path→editor open for local/remote | **P1** |
| **Quake / dropdown terminal** | WT, many | Global hotkey + always-on-top mini mode — care with framed window rules | **P2** |
| **Inline image protocol** | iTerm2, Kitty | Large effort on xterm.js; paste-image path already covers agents | **P2** |
| **WSL / serial / Docker attach profiles** | WT | Custom shell pref covers WSL path; first-class WSL distro picker would help Windows users | **P2** |

### Highest-leverage roadmap (recommended order)

1. **P0 polish:** ~~fix Find hotkey~~; ~~raise scrollback default~~; ~~session restore MVP~~; ~~SSH config import~~; ~~agent docked/float/hide + ask bar~~; close/refresh stale GitHub #3; exit-code tab badges still open.  
2. **P1 differentiators:** OSC 133 blocks + exit codes; browser MCP tools; workflows; vertical tab metadata; selection-aware explain/fix; multi-hop jump; richer session restore (browsers/agents).  
3. **P2 platform:** richer multi-agent panes; structured DevTerm Agent chat; Electron major upgrade; optional native migration research only if Electron ceilings dominate.

### What *not* to copy blindly

- **Drop Electron for Ghostty/Swift** just because cmux is fast — DevTerm's value is Windows + remote SSH + MCP air-gap agent, not macOS-native GPU.  
- **Replace the PTY with a Warp-style reimplementation of the shell** — keep real shells; layer blocks/AI beside xterm.  
- **Cloud agent orchestration (Warp Oz)** — out of scope until local/remote single-host UX is best-in-class.  
- **Bypass the MCP policy boundary** for "smarter" tools — every new host capability goes through `policy.ts` + approval rules.

---

## Audit method (for the next refresh)

When re-auditing this file:

1. Diff `package.json` version + `git log` / tags vs "Recent release notes".  
2. Walk `src/shared/types.ts` `DevTermApi` / `IPC` for new surfaces.  
3. Re-scan for `TODO` / empty hotkey cases / stale "read-only" comments.  
4. Re-check open GitHub issues against implemented components.  
5. Spot-check competitor landing pages only for **product** deltas, not marketing copy.  
6. Prefer code over `README` / `FEATURE-PLANS` when they disagree — then fix those docs in the same change.

When behavior and this file disagree, **trust the code** and update this file in the same change.
