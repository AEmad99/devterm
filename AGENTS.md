# AGENTS.md

Guidance for coding agents working in the DevTerm repository. Read this first; prefer the code over any doc when they disagree, and update this file in the same change when you find drift.

DevTerm is an Electron 29 desktop terminal: local shells (prebuilt node-pty), SSH/SFTP sessions, tiling workspaces, file browsing/editing (CodeMirror 6), an in-app browser, snippets, a Warp-style Git panel, a persistent transfer queue, offline Whisper dictation, global terminal search, and an embedded multi-provider **DevTerm Agent** with seven external CLI fallbacks (`pi`, `claude`, `opencode`, `kimi`, `grok`, `codex`, `antigravity`). Every agent runs in a local PTY and reaches the remote host only through DevTerm's in-process MCP bridge. Stack: electron-vite, TypeScript strict, React 18, Zustand, xterm.js, ssh2, marked + DOMPurify, `@huggingface/transformers`, `@earendil-works/pi-coding-agent` (bundled runtime), a dedicated `node` binary for the agent, electron-updater, zod.

**Version:** `package.json` (currently `1.3.26`). Top-level views: **Terminals** (the always-mounted workspace: group tabs, split panes, local/remote/browser sessions), **Connections**, **Workspaces**, **Snippets**. DevTerm is a normal framed desktop app; the first screen is the terminal, not a marketing page. Release history lives in `CHANGELOG.md` — do not duplicate it here.

## Start here

| Task | Command |
| --- | --- |
| First-time setup | `npm install --ignore-scripts`, then `npm run setup` (Electron + node-pty prebuilt). **Never** `npm rebuild` node-pty, never plain `npm install`. |
| Dev loop | `npm run dev` (hot-reload) |
| Required correctness gate | `npm run typecheck` (node + web tsconfigs) — run before finishing any code change |
| Lint / format | `npm run lint`, `npm run format` (Prettier). Baseline has pre-existing lint findings; fix yours, don't boil the ocean. |
| Tests | `npm run test` (all `*.test.ts` via tsx, 38 files), `npm run test:grid` (grid-spec validation) |
| Smoke | `node scripts/smoke.cjs` (node-pty/ssh2). `electron . --self-test` is the deeper headless check (90s watchdog, needs a build). |
| Package | `npm run build:win` / `build:linux` → `dist/`. Release flow (typecheck + lint + test + smoke → build → commit to `main` → push → tag `v<version>`) only on explicit request. |
| Commit target | Commit directly to `main` unless the user asks for a branch or PR. |

Project skills in `.claude/skills/` (load via the skill tool, they carry the exact workflows):

- `add-ipc` — adding a renderer↔main IPC command (three-layer edit, see below).
- `add-mcp-tool` — adding an agent MCP tool (define in `tools*.ts`, guard in `policy.ts`).
- `verify` — pre-commit sanity (typecheck + lint + smoke).
- `package-win` — Windows NSIS installer (human-invoked only).

## Architecture

| Layer | Path | Role |
| --- | --- | --- |
| Main | `src/main` | BrowserWindow, IPC handlers (`src/main/ipc/*`, registered in `src/main/index.ts` → `registerIpc()`), node-pty, SSH/SFTP, port forwards, fs, transfers, MCP bridge, git, search index, updater, persistence |
| Preload | `src/preload/index.ts` | The **only** typed bridge to the sandboxed renderer (`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`). Nothing reaches the renderer except through here. |
| Renderer | `src/renderer` | React UI, Zustand stores (`store/`), xterm, CodeMirror, browser panes, dictation worker |
| Shared | `src/shared/types.ts` (~2150 lines) | `IPC` channel map + `DevTermApi` interface + domain types. The contract both sides import (`@shared`). |

**The IPC rule (no exceptions):** every renderer→main capability is added in **all three places together** — `src/shared/types.ts` (`IPC` const + `DevTermApi`), a main handler in `src/main/ipc/*` (registered from `src/main/index.ts`), and the preload exposure in `src/preload/index.ts`. A mismatch is a compile error, which is why `npm run typecheck` is the gate. Streaming channels use the per-id suffix convention (`pty:data:<id>`, `ssh:data:<id>`, `agent:bridge-status:<id>`, …) plus the coalescer in `src/main/ipc/coalesce.ts`. Fire-and-forget renderer→main calls go over `ipcRenderer.send`; request/response goes over `invoke`/`handle`.

### Code map (high traffic)

| Area | Location |
| --- | --- |
| App / window / IPC registration | `src/main/index.ts` (`registerIpc()` wires ~20 `register*Ipc` modules) |
| Local PTY | `src/main/pty/manager.ts`, IPC `src/main/ipc/pty.ts` |
| SSH / reconnect / SFTP / watch | `src/main/ssh/{manager,connection,knownHosts,osDetect,sftp,watch,quick-connect}.ts`, IPC `src/main/ipc/ssh.ts` |
| Detached tmux sessions | `src/main/ssh/{tmux,detached-session}.ts`, UI `TmuxPicker` |
| Port forwards (`-L`, SOCKS `-D`) | `src/main/ssh/port-forward.ts`, UI `PortForwardPanel.tsx` |
| MCP server / policy | `src/main/mcp/{server,policy}.ts` |
| MCP tools: host / browser / handoff | `src/main/mcp/{tools,tools-browser,tools-agent}.ts` |
| Agent browser control | `src/main/browser/*` (control registry, snapshot refs, URL guard), IPC `src/main/ipc/browser-control.ts` |
| Agent launch (bundled + 7 fallbacks) | `src/main/agent/{launch,context,extension,agent-bin,host-backend}-*.ts` (`claude-`, `codex-`, `opencode-`, `kimi-`, `grok-`, `antigravity-launch.ts`) |
| Agent UI + IPC + broadcast | `AgentPane.tsx`, `agent-window.{html,tsx}`, `lib/agent-ui.ts`, main `src/main/ipc/{agent,broadcast}.ts` |
| Approval rules & activity | `src/main/agent/{approval-rules,bridge-activity}.ts`, UI `AgentActivityPanel.tsx`, IPC `src/main/ipc/foundation.ts` |
| Search index | `src/main/search/*` (ANSI strip at ingest) |
| Git | `src/main/git/index.ts` (single file), UI `src/renderer/components/git/*` |
| Transfers | `src/main/transfers/{queue,store}.ts` (`transfer.ts` is a self-test helper), IPC `src/main/ipc/transfers.ts` |
| Session restore | `src/renderer/lib/session-restore.ts`, `src/main/ipc/session-restore.ts` |
| SSH config import | `src/main/ssh/ssh-config-parse.ts`, Connections “Import SSH config” |
| Sessions / layout / settings stores | `src/renderer/store/{sessions,layout,settings}.ts` |
| Terminal chrome | `TerminalLayout.tsx`, `TerminalView.tsx`, `RemoteSessionView.tsx`, `LocalSessionView.tsx`, `BrowserPane.tsx` |
| Tab labels / status | `src/renderer/lib/{tab-label,tab-status}.ts` |
| Themes / hotkeys / attention | `src/renderer/lib/{themes,hotkeys,attention}.ts` |
| Styles | `styles.css` imports `styles/{base,chrome,terminal,panels,motion}.css` |
| Settings import/export | `src/main/settings/settings-io.ts` |

## Sessions, layout, and the always-mounted invariant

- `Session` (`store/sessions.ts`) has `kind: 'local' | 'remote' | 'browser'`, plus `cwd` (OSC 7), `agentUiMode/agentKind/agentPtyId/agentBridgeState/agentPendingApproval`, `needsAttention/hasUnreadOutput/processRunning/exitCode`, `connectionId` (saved-SSH remotes), `groupId`, and browser-only `url/agentOwnedBy/firstTabKey`.
- Tiling model: binary split tree in `store/layout.ts` (`leaf` holds pane tabs; `split` divides `row`/`col` with fractional sizes; `groups` hold independent trees, default group is `default`). `TerminalLayout.tsx` computes rects and renders one stable `.term-slot` per session. **Inactive groups stay mounted, hidden via `.term-hidden` (visibility + off-screen translate, never `display:none`).**
- **Critical:** never unmount `TerminalLayout`, never reparent xterm DOM slots — either destroys PTYs/SSH shells. Focus mode (`focusedId`, Ctrl/Cmd+Shift+Z) and zen mode (`zenMode`, Ctrl/Cmd+Alt+Z) only reposition/hide; never scale terminal text (blurs).
- Terminal grids: `CreateGridModal.tsx` + `lib/createGrid.ts` (max 4×4), restored via the shared `restoreGroup` path. Remote grid cells each get their own ssh2 client. Groups launched from workspaces carry `launchedFromWorkspaceId` in `groupFlags` for “Save back”.
- Tab labels compress long agent/shell activity (`lib/tab-label.ts`); busy tabs are width-capped. The one-time welcome hint (“Getting started”) is sticky — settings import must not resurrect it.

## Terminals

- **Local PTYs** (`src/main/pty/manager.ts`): shell comes from the `defaultShell` pref (`auto` / `pwsh` / `powershell` / `cmd` / `custom`); PowerShell gets OSC 7/133 prompt hooks (explicit shell args bypass injection). A fresh PTY exiting with no output fires `pty:startup-failure:<id>` with a targeted diagnostic (classic Windows PowerShell 5.1 signature failure).
- **Remote SSH — one primary ssh2 client per session** (`src/main/ssh/manager.ts`) is shared by shell, SFTP, exec, watch polling, port forwards, git ops, and agent tools on normal remotes. Windows compatibility mode is the scoped exception: when a Windows OpenSSH server resets a connection on a second channel (common with `MaxSessions=1`), command and SFTP work use isolated auxiliary clients, and active port-forward streams lease one bounded manager-owned forwarding transport, while the visible shell stays alone on the primary client. Direct hops set `setNoDelay(true)` — keep it. Single bastion hop via `profile.jump` (multi-hop chains are not supported). TOFU host keys in `userData/known_hosts.json` (mode 0o600; mismatches rejected). Auto-reconnect with exponential backoff (`ReconnectPolicy`); session ids stay stable across reconnects.
- **Shell integration:** remote shells get OSC 7 (`__dt7`) and OSC 133 (`__dtA`/`__dtB`) hooks — idempotent bash/zsh wraps, PowerShell prompt fn on Windows remotes. Inside tmux, hooks emit DCS-wrapped OSC (`\ePtmux;…`) with `allow-passthrough` enabled. POSIX inject goes through `buildPosixShellIntegrationSetup` via `writeQuiet` (`stty -echo` as its own line, then payload) — never `clear`, never type setup into an existing tmux pane (fresh sessions only), and keep the deferred `${__dtA}`/`${__dtB}` PS1 references (baking the tmux DCS envelope into PS1 prints a stray `]` — regression-tested in `detached-session.test.ts`).
- **Detached sessions** (`remoteDetachedSessions`, default on): POSIX remotes with a *working* tmux (`tmux -V`, not just `command -v`) get a pane-local picker (`TmuxPicker` + `ssh.listTmux/attachTmux/killTmux`) with live pane preview, window/command/cwd metadata, create-and-attach, kill, or normal login shell. Reopen via pane button, Ctrl/Cmd+Alt+T, or palette. Attach is a child process, **never `exec`**, so prefix+d returns to the login shell. Switching while attached uses `tmux switch-client`. A tmux client that still exits reopens a normal shell without firing `ssh:exit`. Broken tmux installs skip the picker. Reconnect re-attaches only if the operator was still inside the chosen session.
- **`exec` timeouts** resolve `timedOut: true` with partial output — not a disconnect. Port forwarding: local `-L` and dynamic `-D` SOCKS5 (no-auth, CONNECT only).
- **Renderer:** terminals use the **canvas** addon on purpose (`lib/renderer.ts`) — WebGL is avoided because every session stays mounted and Chromium's ~16 WebGL context cap blanked panes. Fallback is xterm DOM. Do not switch to WebGL without a context-budget strategy. Default scrollback 10 000 (clamp 100–100 000).
- **Autosuggest** (`lib/autosuggest.ts` + `Autosuggest.tsx`, history-driven) uses OSC 133 `;B` as the command-input anchor; accepting sends keystrokes to the shell, never writes into the buffer. Requires working prompt hooks.
- **Find:** per-pane SearchAddon bar via `SearchBar`, opened from the xterm key handler **and** the App global hotkey through `openTerminalFind` / `registerFindOpener` in `lib/terms.ts`. Per-pane find is Ctrl/Cmd+Shift+F; global search is Ctrl/Cmd+Alt+F.

## Agent bridge (DevTerm Agent + 7 fallbacks)

**Product default:** `agentKind: 'devterm'` — the bundled multi-provider agent (`@earendil-works/pi-coding-agent` + packaged `node` binary), not an external CLI. `AgentKind = 'devterm' | 'claude' | 'pi' | 'opencode' | 'kimi' | 'grok' | 'codex' | 'antigravity'`.

| Kind | Prep | How it reaches MCP |
| --- | --- | --- |
| `devterm` | `prepareBuiltinAgentLaunch` in `launch.ts` | Bundled Node + CLI + `devterm-mcp.mjs` extension. **Remote:** `--no-builtin-tools` (host work is MCP). **Local:** builtin fs/shell on, process cwd = operator folder; MCP is browser-only |
| `pi` | `prepareAgentLaunch` | PATH `pi` + same extension isolation flags |
| `claude` | `claude-launch.ts` | Native MCP via `--mcp-config`; keeps local Read/Write/Edit for scratch (remote) or Bash/Glob/Grep too (local) |
| `opencode` | `opencode-launch.ts` | Per-session `opencode.json` remote MCP entry; tools as `devterm_*` |
| `kimi` | `kimi-launch.ts` | Per-session `.kimi-code/mcp.json`; tools as `mcp__devterm__*` |
| `grok` | `grok-launch.ts` | Per-session `.grok/config.toml` HTTP MCP; tools as `devterm__*` |
| `codex` | `codex-launch.ts` | Isolated `CODEX_HOME/config.toml` HTTP MCP; tools as `mcp__devterm__*` |
| `antigravity` | `antigravity-launch.ts` | Per-session `.antigravity/mcp.json` HTTP MCP for Google `agy` |

- MCP bridge (`src/main/mcp/server.ts`) on `127.0.0.1:<random-port>` gated by a random Bearer [REDACTED] MCP launch uses policy mode `full` (no DevTerm confirm modal) — permission prompts belong to the agent CLI. Approval rules (`approval-rules.ts`, `userData/approval-rules.json`, UI under Settings → Agent guardrails) remain a **PRE-CHECK** allow/deny/ask at the MCP boundary. There is no per-session policy picker.
- **Host tools** (`tools.ts`, remote only, against `SshHostBackend`): `ping`, `get_host_context`, `run_command`, `list_dir`, `read_file`, `write_file`. Local agents do **not** register these (`hostTools: false`); they use the CLI's own tools in the operator folder (`resolveLocalSpawnCwd`). Relative paths and `run_command` on POSIX remotes honor the live POSIX cwd from OSC 7; Windows remotes use the Windows compatibility clients and Windows path wrappers.
- **Browser tools** (`tools-browser.ts`, Settings → DevTerm Agent toggle, default on — 11 tools): `browser_list/open/navigate/snapshot/click/type/press_key/screenshot/attach/detach/close`. Agent-owned tabs (badged `AGT`) are freely drivable; operator tabs need one-time per-tab confirm (`browser_attach`, in-memory grants cleared on Stop/close). Snapshots inject ref tags (`data-dt-ref`); results carry an UNTRUSTED banner (prompt-injection defense). Navigation reuses the guest URL guard — http(s)/about:blank only. Password fields follow the policy ladder; approval-rule prefixes match URLs/origins.
- **Local handoff** (`tools-agent.ts`, local-only, default on): `agent_list`, `agent_delegate`, `agent_message` — visible sibling tabs, source cwd/leaf preserved, per-source delegate cap, never registered on remote bridges. Close the target tab to stop only that agent.
- Briefings: remote writes per-session `AGENTS.md` in a temp overlay (`buildAgentsMd`); local appends `buildLocalNativeMd` via `--append-system-prompt` without planting files in the project.
- Bridge status over `agent:bridge-status:<id>`; MCP `notifications/message` heartbeat every 25s; renderer pushes live cwd via `agent:set-cwd`; confirmations (`agent:confirm`) time out after 120s as `'timeout'`. Confirms and PTY data are **broadcast** to every `BrowserWindow` so a floating agent window can approve and stream.
- **Agent PTY is not killed on its own exit** — bridge + temp dir stay up for auto-restart after SSH reconnect; cleanup only on explicit **Stop** / session close / quit. Activity log: `bridge-activity.ts` → `AgentActivityPanel.tsx` (filterable, exportable JSONL).
- Resume keys: remote `deriveAgentSessionId` (saved connection or `user@host:port`); local `deriveLocalAgentSessionId(cwd)` so two folders never share a transcript. When `resumeSessions` is on, launch uses `--session-dir <userData>/agent-sessions --session-id <stable-id>`, else `--no-session`.
- DevTerm Agent settings (`agentPreferences` in `store/settings.ts`): provider/model, ordered `fallbackModels` (`provider/model` pairs) used on HTTP 408/429/5xx via `registerModelFailover` in `extension.ts`. Credentials never cross DevTerm IPC — keys stay in Pi's auth store (`~/.pi/agent/auth.json`) or process env; `agent:capabilities` reports runtime version, model catalog, and authenticated-provider **presence** only. Instruction-only skills allowlistable with SHA-256 pin (`trustedSkills`, re-checked every launch); executable third-party extensions stay disabled.
- **Agent UI modes — process lifetime ≠ UI placement** (`session.agentUiMode`, `store/sessions.setAgentUi`; main tracks via `agent:set-ui-mode`, broadcasts `agent:ui-mode-changed`):

| Mode | UX |
| --- | --- |
| `docked` | Side column beside the remote shell |
| `hidden` | Full terminal estate; process keeps running; chip shows mode + last task |
| `floating` | Separate OS `BrowserWindow` (`agent-window.html` + `agent-window.tsx`) for multi-monitor |

- `agent:open` is **idempotent** unless `forceRestart` (Restart button). Mode switches reattach and must never kill the agent. Main window keeps a **stashed** `AgentPane` (`.agent-ui-stash` + `.term-hidden`) while alive so scrollback survives; only the active surface sends input/resize and attention chimes. **Open Agent** is an icon cluster on the pane tab strip (`PaneAgentControls`): sparkle launches, letter mark picks the backend, hide/float/stop once running. Remote docks a side column; **local occupies the pane** (shell stays mounted, hidden) so the MCP bridge incl. `browser_*` stays wired. Floating window: Dock/Hide/Stop; OS close (X) demotes to `hidden`. Closing the remote tab calls `agent.close` + `agent.closeWindow`. Helpers: `lib/agent-ui.ts` (`ensureAgent`, `stopAgent`, `setAgentUiMode`).
- Attention signals (`lib/attention.ts`) are agent-oriented: Web Audio chime, OS notification + taskbar flash, tab badge, idle-after-burst detector (heuristic — no OSC 9/133-C/D protocol).

## Files, editor, browser panes

- `FileExplorer` follows the active shell cwd: local via fs IPC, remote via SFTP on the same ssh2 client. Shared `FsApi` abstraction (`src/renderer/lib/fsapi.ts`). Listings live-update via `FsApi.watch()` (local `src/main/fs/watch.ts`; remote SFTP poll at 2500ms) — never add manual refresh as the primary path.
- Editor: CodeMirror 6 (`EditorView.tsx`), max 5 MiB (`MAX_EDIT_BYTES`), original EOL re-applied on save; sanitized Markdown preview (`lib/markdown-preview.ts`, marked GFM + DOMPurify; Edit/Side/Preview, Ctrl/Cmd+Alt+M). Opening a file must keep the Terminals/file tab strip so users can leave the editor.
- Dual-pane SFTP browser uses the **persistent transfer queue** (legacy ad-hoc transfer IPC is gone from the renderer).
- Browser panes: `<webview>` on partition `persist:browser`, hardened in `src/main/index.ts` + `src/main/ipc/browser.ts` (preload stripped, `nodeIntegration: false`, http(s)/about:blank only with other schemes to the OS browser, sensitive permissions default-denied, de-Electroned UA). Per-origin zoom in `userData/browser-zoom.json`; downloads to `userData/Downloads` with ~150ms-throttled progress. Browser panes are sessions (groups/tabs/splits/focus) but create no PTY or SSH channel.

## Search, palette, git, transfers, dictation, workspaces, restore

- Global search (`src/main/search/index.ts`): in-memory, 2000 lines/session, fed by local PTY **and** remote SSH output; ANSI/VT/C0 stripped at ingest. Optional persistent tail: `settings.searchPersist` → `userData/search/<sessionId>.jsonl` (FIFO cap).
- Command palette (Ctrl/Cmd+K, user-overridable in `lib/hotkeys.ts`): fuzzy + frecency; Actions / Snippets / Connections / Workspaces / History. History merges DevTerm records with host shell-history files; PSReadLine multi-line (trailing-backtick) continuations are reassembled, multi-line junk excluded rather than mangled. Snippets (`userData/snippets.json`) support `{{placeholders}}`.
- Git panel (`components/git/*`, logic `src/main/git/index.ts`): **full read + write** (status/diff/log/branches/remotes/stash/tags/blame/show + checkout/branch/fetch/pull/push/commit/stage/discard/tag/remote/merge). Remote ops reuse the session's exec channel; `git:on-change` polls every 5s; writes invalidate the status cache. Graph in `GitGraphView.tsx`. Destructive actions use shared `ConfirmDialog`, never `window.confirm`. (A stale “read-only” comment in `types.ts` is wrong — do not re-introduce read-only framing.)
- Persistent transfer queue (`src/main/transfers/*`, `userData/transfers.json`): concurrency 2, survives restarts, **no mid-file resume** (interrupted items are canceled; users retry). Progress events are coalesced; `selectVisible` is last-24h and must stay referentially stable for Zustand (use `useShallow`).
- Voice dictation: renderer-only Whisper (`src/renderer/lib/stt/*`), WebGPU→WASM fallback, push-to-talk (Ctrl/Cmd+Shift+M), models cached in `persist:browser`; `ort/*.wasm` must stay `asarUnpack`ed. Worker crash recovery discards stale ready messages.
- Workspaces (`userData/workspaces.json`, no secrets): capture / launch / rename / duplicate / `autoLaunch` on boot (each into its own group). Ad-hoc SSH sessions without a saved `connectionId` are skipped on capture.
- Session restore (`settings.sessionRestore`, default on): debounced snapshot of groups → `userData/session-restore.json`; boot order is auto-launch workspaces → restore snapshot → empty local. Restores local shells, saved SSH, browser panes at their latest active URL, agents, and editors (not ad-hoc SSH, extra in-pane browser tabs, or terminal scrollback).
- SSH config import (Connections → “Import SSH config”, `ssh-config-parse.ts`): concrete Hosts only, merges Host * defaults, skips duplicates, no passwords. QuickConnect (`userData/quick-connect.json`): MRU `host:port:user` triples (cap 20) feeding the host datalist; known-hosts management UI under Connections.

## Settings, theme, window

- Settings (`store/settings.ts`: theme, terminal prefs, autoReconnect, attention, agentKind/agentPreferences, remoteDetachedSessions, sessionRestore, defaultShell, gitPanelOpen, keybindings overrides, stt, searchPersist, …) persist to renderer `localStorage` (`devterm.settings.v1`), mirrored to `userData/settings.json` via `settings:sync`. Export/import (`src/main/settings-io.ts`) strips secrets and merges through the same normalizers as load.
- One theme drives chrome + xterm palette via CSS variables (`lib/themes.ts`, 9 themes incl. Glass) — use variables / `color-mix` (e.g. `--danger`, `--ok`, `--font-mono`, `--font-ui`), never hardcoded colors. Motion is CSS-only behind `prefers-reduced-motion` guards; never animate/scale the xterm viewport.
- Keybindings: ids in `lib/hotkeys.ts`, user-overridable; App focus guards avoid firing most shortcuts while typing in an editor.
- Window: normal framed opaque BrowserWindow — Windows owns snapping/titlebar; never add custom snap or fake window controls. Key flags: `backgroundThrottling: false`, `webviewTag: true`, `autoHideMenuBar`, caches pinned into `userData`, top frame navigation-locked, `appUserModelId com.devterm.app`. Local performance telemetry is on-demand `performance:snapshot` IPC polled ~3s from Settings → Performance — nothing sampled in background or uploaded.
- Auto-update: `src/main/updater.ts` (electron-updater, GitHub `AEmad99/devterm`, unsigned, skipped in dev/self-test).
- Shared UI helpers: `ConfirmDialog`, `useEscapeKey`, `formatBytes`, `ModalShell` a11y (`role="dialog"`, `aria-modal`, `aria-labelledby`); pane tabs use `role="tablist"` / `role="tab"`.

## Persistence

| Store | Contents |
| --- | --- |
| `userData/connections.json` | Saved SSH profiles; secrets safeStorage-encrypted (incl. bastion `jump`) |
| `userData/workspaces.json` | Workspace snapshots (no secrets) |
| `userData/snippets.json` | Command snippets |
| `userData/approval-rules.json` | Agent allow/deny/ask rules |
| `userData/known_hosts.json` | TOFU host keys (mode 0o600) |
| `userData/transfers.json` | Persistent transfer queue |
| `userData/browser-zoom.json` | Per-origin webview zoom |
| `userData/bridge-activity.jsonl` | Agent bridge activity log |
| `userData/settings.json` | Settings mirror from renderer |
| `userData/agent-sessions/` | Optional resumable DevTerm Agent transcripts |
| `userData/agent-artifacts/` | Agent browser screenshots (`browser_screenshot`) |
| `userData/search/<sessionId>.jsonl` | Optional persistent search tail |
| `userData/quick-connect.json` | MRU host triples |
| `userData/session-restore.json` | Last-session groups/layout snapshot (no secrets) |
| `userData/Downloads/` | Browser downloads |
| Renderer `localStorage` `devterm.settings.v1` | Full settings (no secrets) |

**In-memory only:** live sessions/layout (mirrored to session-restore when enabled), group flags, editors, transfer runtime, agent processes, search index (unless `searchPersist`), dictation state.

## Packaging

- `electron-builder.yml`: `appId com.devterm.app`, NSIS x64 (`oneClick: false`, `perMachine: false`), unsigned (`verifyUpdateCodeSignature: false`), `npmRebuild: false`, GitHub provider `AEmad99/devterm`. NSIS reinstall logic in `resources/installer.nsh` force-kills install-dir processes (elevated UAC inner installs skip stock `CHECK_APP_RUNNING`).
- `asarUnpack` must keep: `node-pty`, `**/*.node`, `ort/*.wasm`, agent Node binary (`node/bin/**`), `@earendil-works/**` and the listed agent runtime dependency closure. Dropping entries breaks the built-in agent (external Node can't resolve modules inside `app.asar`) or dictation.
- Windows packaging must ship `node-pty/build/Release/conpty.node` (and the rest of the prebuilt Release dir). The npm package's `files` field omits `build/`; `scripts/before-pack.cjs` patches that in, and `scripts/after-pack.cjs` fails the build if the unpacked output is still missing the natives. Never ship a Windows installer that cannot spawn a local PTY.
- Unsigned builds: pass `CSC_IDENTITY_AUTO_DISCOVERY=false` if packaging hits winCodeSign symlink issues on Windows.

## Tests

38 `*.test.ts` files (run via `npm run test`): agent launch modules (`agent-bin`, `launch`, `claude`, `opencode`, `kimi`, `grok`, `antigravity` — note: no `codex-launch.test.ts`), approval-rules, agent context, host-backend, browser control/interact/snapshot/url-guard, MCP policy/tools-agent/tools-register, search ansi/index, ssh detached-session/manager lifecycle/OS detection/ssh-config-parse/tmux/windows-host, shell-quote, history-parse, pty-native-pack, plus renderer-side extractCommandPrefix, file sort, markdown-preview, snippets, stt resample, tab-label, tab-status, transfer stats, layout, and SSH session status lifecycle. Large surfaces (layout DnD, live SSH reconnect, SFTP queue, multi-window agent) rely on self-test + manual QA — the biggest coverage gap.

## Critical rules

- Keep terminals mounted: hide with `.term-hidden`; never unmount `TerminalLayout` or reparent xterm DOM slots.
- Never rebuild node-pty; keep node-pty, `ort/*.wasm`, and the bundled agent runtime `asarUnpack`ed.
- Add IPC through shared types + main handler + preload together; register new `src/main/ipc/*` modules from `registerIpc()` in `src/main/index.ts`.
- Keep one primary SSH client per session for normal remotes. Windows OpenSSH compatibility may use the manager-owned command-only, SFTP-only, and pooled forwarding auxiliary clients when the target cannot multiplex shell/session channels; never add untracked duplicate connections. A Windows shell channel that closes without an exit status gets bounded recovery while its transport is alive.
- Preserve OSC 7 cwd tracking and OSC 133 prompt markers (local + remote, incl. tmux DCS wrapping and the deferred `${__dtA}`/`${__dtB}` PS1 form).
- Use `FsApi.watch()` for live listings; no manual refresh as a primary path.
- Respect the MCP policy boundary in new tools; approval-rules pre-check overrides the mode for allow/deny. Credentials for model providers never travel over DevTerm IPC.
- Agent terminal output is user-facing data, not app state; don't kill the agent PTY on its own exit.
- Agent **process lifetime ≠ UI mode**: hide/float/dock must not call `agent.close`; only explicit Stop / session close / quit. Keep `agent:open` idempotent unless `forceRestart` — but the reattach path must also require the stored `lastOpts.kind` to match, otherwise switching kinds in the picker silently re-shows the old kind's live process.
- Settings persist to renderer `localStorage`, mirrored to `userData`; export/import bundles strip secrets and merge through normalizers.
- Transfers do not resume mid-file across restarts.
- Use theme CSS variables; keep motion out of the xterm viewport and behind reduced-motion guards.
- Keep the BrowserWindow normal/framed; Windows owns snapping — no custom window controls.

## Known limits (verified against code — re-verify before fixing)

- **Windows remotes are first-class for agents:** OpenSSH exec is wrapped in PowerShell (`Set-Location` + EncodedCommand) so `run_command` and relative file tools follow OSC 7 cwd. SFTP paths round-trip `C:\\Users\\...` and `/C/Users/...`. Interactive Windows shells launch PowerShell with OSC 7/133.
- **No bridge tools for git/search/forwards** — agents shell those out via `run_command`. Capability ceiling, not a bug.
- **Restore is MVP:** local shells, saved SSH, browser panes at their latest active URL, agents, and editors survive restart. Extra in-pane browser tabs, ad-hoc SSH, and terminal scrollback don't. Local detach/reattach is not shipped (PTYs die with the app).
- **Single bastion hop** (`profile.jump`); no ProxyJump chains. No block-based terminal UI (OSC 133 A/B only, no C/D exit markers), no programmable app CLI/socket API, no inline images/sixel, no OSC 9/99 attention protocol.
- **Mount-everything × renderer cost:** every session stays mounted by design; canvas renderer + 10k scrollback bound the cost, but many groups/grids still burn RAM/CPU. No auto-hibernate.
- **Electron 29 age:** behind current majors; upgrade is a project (webview, node-pty ABI, asarUnpack), tracked as platform risk. macOS is not a product focus (no signed release pipeline).
- Open GitHub issues (`AEmad99/devterm`): **#1** command syntax highlighting (hard in a raw PTY — shell owns the line; scope to block UI/input editor or set expectations), **#2** app preview/annotate mode (not shipped).

## Doc pointers

- `README.md` / `OVERVIEW.md` — user-facing product description and quick start.
- `CLAUDE.md` — longer narrative walkthrough of user flows (overlaps this file; this file wins on conflicts).
- `CHANGELOG.md` + `release-notes-v1.3.*.md` — release history.
- `FEATURE-PLANS.md` (2026-06-25) — stale in places (global search, remote tmux, session-restore MVP, SSH import have **shipped**); trust the code.
- `TAURI-MIGRATION.md` — native-migration research only; not a direction unless Electron ceilings dominate.
- `plans/` — one-off design notes (`terminal-grid.md`, `markdown-preview.md`).
