# Changelog

All notable changes to DevTerm are documented here. The most recent section is
at the top. Dates are ISO `YYYY-MM-DD`.

## Unreleased

### Changed

- The first-run hint is a full-width row of three cards above the terminal panes. Each card is one step (local terminal, SSH connection, DevTerm Agent), finished steps stay marked done, and an open card jumps to that surface. Dismiss still hides the row, and importing settings does not bring it back.

## 1.6.2 — 2026-09-23

### Changed

- The app opens in a terminal group. A fresh run is one group with one local terminal. Reopening restores the saved groups and however many terminals they held. The home group tab stays on the group bar even when it is the only group.

### Fixed

- Remote shell integration waits until the login banner goes quiet before installing prompt hooks, and no longer opens the PTY with echo disabled. Long MOTDs were racing that inject and leaving typed characters invisible.

## 1.6.1 — 2026-09-23

### Improved

- Agent browser control uses trusted CDP clicks/types with DOM fallback, plus fill / select / scroll / hover / wait / focus, SPA settle waits, stale-ref remapping, and console / navigation / download notes for every agent kind.

## 1.6.0 — 2026-09-23

### Added

- **Cursor Agent** as a ninth external CLI backend. Launch prefers the official `%LOCALAPPDATA%\cursor-agent\` install (and the `cursor-agent` shim) over a bare `agent` on PATH, wires an isolated `.cursor/mcp.json` HTTP MCP bridge, and starts with `--yolo --approve-mcps --sandbox disabled`. Remote sessions get a temporary `AGENTS.md`; local sessions plant guidance under `~/.cursor/rules/devterm-local.mdc`.

### Fixed

- Local PTYs advertise `COLORTERM=truecolor` and no longer inherit parent `NO_COLOR` / `FORCE_COLOR=0`, so agent TUIs (especially Muse’s TextMate themes) get full syntax highlighting instead of a 16-color fallback.
- Isolated Muse sessions pin `tui.color_depth: truecolor` so ConPTY does not probe down to 16 colors and skip the TextMate theme.
- Windows taskbar / titlebar icon prefers the multi-size `.ico` path, and unpackaged dev builds use a distinct AppUserModelID so they do not steal the installed shortcut’s icon association.

## 1.5.0 — 2026-09-22

### Changed

- The README and first-run hint now lead with DevTerm's remote-agent workflow: agents run locally and work over SSH without a server-side agent install or outbound internet requirement. The checklist lists only the steps that are still open.
- The file explorer, connections, workspaces, and snippets open from a left rail beside the terminal and start closed. The shell stays on screen.
- Lists in that rail keep each name on one line and show pin / edit / delete as icon buttons beside the primary action, so rows never shift or clip when you hover.
- Completed commands show a full-height bar, and the newest command has a header with Copy and Ask agent. The bar and header pick up an exit status when the shell sends OSC 133 D.
- The agent control on each pane shows the backend name. The status bar can open that agent, agent activity, and the transfer queue.
- The focused split uses an accent outline.

### Fixed

- Settings rows render on one line again. A generic `.modal label` rule outranked the dialog's own row style, so every row stacked and centred its label above the control. The dialog also drops the modal's inherited gap, and text fields now share the slider width instead of the narrower default.
- Theme swatches show a full-width preview. The mini-terminal preview had no width of its own and relied on flex stretch, so it collapsed to the width of its own text and left most of the tile empty.

### Removed

- The titlebar Activity / Transfers / Off switch. Those panels toggle from the status bar.
- The unwired command-input component left behind when the bottom input strip was removed. The shell still owns the prompt.

## 1.4.2 — 2026-09-21

### Fixed

- Preview comments and Agent cockpit Delegate use in-app editors. Electron does not show `window.prompt()`, so those actions previously did nothing. Preview opens in Browse mode, and the drawing layer covers only the page.
- The first-run checklist sits above the terminal panes and finishes without picking a theme.
- A render error in one pane stays in that pane. A main-process async error is a toast once a window exists, instead of a dialog that freezes every terminal.
- A failed SSH reconnect can be retried on the same tab. A remote preview with no local forward opens the port-forward panel.
- Command gutters keep only the newest 48 decorations. An agent that fails to start shows in the cockpit, the status bar, and a toast.

## 1.4.1 — 2026-09-21

### Removed

- The optional OSC 133 command input strip at the bottom of the terminal. Completed-command gutters (Copy / Ask agent / Comment) stay.

### Fixed

- Packaged Windows builds now ship `icon.ico` / `icon.png` as real files (extraResources + extraFiles next to the exe) and apply them to the window, tray, notifications, and NSIS installer. A previous copy treated the logo path as a directory, so the installed app had no icon.

## 1.4.0 — 2026-09-21

Quit is safer, large workspaces stay usable, and the agent can see more of what you see. Remote hosts still need nothing installed. The product logo is packed into the installer (`extraResources`) and applied to the window, tray, and notifications.

### Added

- **Preview + annotate.** Palette actions open a hardened in-app preview of a localhost port, a local (-L) forward, or a folder served on `127.0.0.1`. Overlay pins, rectangles, and comments persist under `userData/annotations/`. Send comments (and an optional screenshot) to the pane agent. MCP tools: `preview_open`, `preview_snapshot`, `preview_comments`.
- **Agent cockpit** (Ctrl/Cmd+Alt+A) shows last task, running/idle, cwd, host, kind letter, age, and UI mode, plus Focus pane and local Delegate.
- **Read-only MCP tools** `git_status`, `git_diff`, and `search_terminals`. Commit and push stay in the Git panel or an explicit `run_command`.
- **ProxyJump chains** of up to two extra hops (three including the target). Connection form “Add jump host”; OpenSSH config import reads comma-separated `ProxyJump` lists. Existing single-hop profiles still load.
- **First-run checklist** (local terminal, save/import a connection, open Agent, pick a theme) replaces the sticky Getting started hint and is not resurrected by settings import.
- **Connection tags** for local filtering in Connections and ranking in the command palette (pinned → last used → tag match → name).
- **Image paste into a focused agent** writes a PNG under `userData/agent-artifacts` and injects the path.
- **Personal markdown skills** from `userData/skills` and `~/DevTerm/skills` (instruction-only, SHA-256 re-hashed every launch).
- **Optional idle/approval webhook** and Telegram notify (bot token stored via OS encryption). Existing toasts and taskbar flash stay.
- **Ask agent about this.** Right-click a terminal selection, the command palette, or the file editor toolbar sends the quoted text to that pane’s agent (starts one if needed). Works while the agent UI is floating. The payload is context only — it does not invent a fix.
- **Performance presets** in Settings → System: Balanced (default), Low memory, and Full fidelity, wired to hibernate, scrollback, search index size, and background remote connect. The performance snapshot still polls only while that page is open.
- **Optional command input editor and block gutters** on shells with OSC 133 hooks. The editor highlights the next command; Enter types it into the shell. Completed commands (A then B) get a faint gutter with Copy / Ask agent / Comment. Panes without hooks look as they did before.

### Changed

- Terminal output is now retained in a bounded main-process ring for each local
  PTY and SSH shell, preserving ANSI data for hidden-pane replay while visible
  streaming and main-side search ingestion remain unchanged.
- Hidden non-active terminal groups can now hibernate only their renderer xterm
  surfaces after a configurable delay (30 seconds by default); PTY, SSH, and
  agent processes remain alive, and recent ANSI output is replayed on return.
- SFTP directory watchers and Git status on-change polls now pause for hidden
  or hibernated groups and perform one immediate refresh when the group returns,
  without affecting transfers, SSH sessions, or agent host tools.
- Session restore, workspace auto-launch, and remote grids now paint their tabs
  before opening SSH, connect the active group with a 300ms stagger, and defer
  background remotes until focus by default. Restore progress reports hosts up
  inline and failed tabs are clickable; the background policy is configurable
  under Settings → General.
- Session restore now keeps a bounded raw ANSI scrollback tail, ad-hoc SSH
  drafts, and every browser tab. Ad-hoc credentials use safeStorage when
  available; otherwise the restored tab asks for authentication without putting
  a password in the restore JSON.
- Optional “Keep sessions running in the tray” keeps the main process, local
  PTYs, SSH clients, and agents alive when the window is closed; reopening
  replays terminal surfaces, while explicit Quit still stops everything.
- Incomplete SFTP transfers now survive a restart as paused rows. Resume
  continues from the persisted offset after checking source size/mtime; cancel
  and quit leave a `.partial` file instead of deleting it.
- Connections can use the system OpenSSH agent (Windows named pipe
  `\\.\pipe\openssh-ssh-agent`). The option defaults on when no password or
  key is set; agent-only failures report that the system agent has no usable
  key.

## 1.3.30 — 2026-09-16

### Fixed

- Windows terminals and SSH-backed agent panes use the in-box ConPTY by default, avoiding access-violation crashes in node-pty's bundled `OpenConsole.exe` helper that surfaced as main-process JavaScript errors and dropped sessions.

## 1.3.29 — 2026-09-15

### Changed

- **Dependency-stack audit.** React 19, Vite 7, TypeScript 6, ESLint 10, zod 4, marked 18, electron-builder, the bundled Node runtime, and the DevTerm Agent runtime (pi-coding-agent 0.85). Electron, xterm, and TS 7 stay pinned — blocked by the node-pty prebuilt ABI and peer constraints.
- `npm audit` is clean: `overrides` pin the `adm-zip` and `sharp` transitives above their vulnerable ranges.

### Fixed

- Packaged builds ship the agent's full nested dependency closure (`afterPack` mirrors `pi-coding-agent/node_modules` into `app.asar.unpacked`) — the bundled agent previously failed to boot with `ERR_MODULE_NOT_FOUND`.
- `npm run setup` hardens native-binary setup (integrity-label resets, ABI marker).

## 1.3.28 — 2026-09-15

### Fixed

- Muse agent panes inherit the operator's safe model, reasoning, and TUI theme preferences while keeping permissions, hooks, and unrelated MCP servers isolated.
- Embedded agent terminals use the complete application ANSI palette, restoring provider syntax highlighting and consistent colors.
- Qualified DevTerm Agent model selections no longer conflict with a separate provider flag and fall back to the wrong model.

## 1.3.27 — 2026-09-15

### Added

- **Meta Muse Code provider.** DevTerm can launch the installed Windows Muse Code CLI through an isolated per-session MCP settings home, temporary auth copy, and the Muse `--yolo` unattended mode. Remote sessions keep host work on the DevTerm bridge with Muse's native shell and workspace writes disabled.

## 1.3.26 — 2026-09-14

### Fixed

- Packaged Windows builds ship node-pty's ConPTY native addons (`conpty.node`). v1.3.25 omitted `build/Release` (the npm package's `files` field does not list it), so every local PTY — including all agents — failed with `Cannot find module '../build/Release/conpty.node'`. Packaging now patches that `files` list and fails the Windows build if the natives are missing.
- `npm run setup` extracts the bundled Node `.zip` with PowerShell on Windows so Git Bash's GNU tar cannot strand the agent runtime install.

## 1.3.25 — 2026-09-14

In-app browser hardening and Windows OpenSSH transport isolation.

### Fixed

- Windows OpenSSH keeps the visible PowerShell terminal isolated from commands, SFTP, and port-forward streams, and performs bounded recovery when an unexpected shell-channel drop leaves the SSH transport alive.
- Compatibility connections to older Windows OpenSSH servers prefer a faster fixed-group key exchange after the host is identified as Windows, while retaining modern algorithms first.
- In-app browser navigation and certificate handling are hardened (persistent page state, mounted inactive tabs, certificate trust prompts).

## 1.3.24 — 2026-09-14

Windows OpenSSH stability follow-up.

### Fixed

- Interactive Windows shells now preserve input typed while the SSH channel is opening, translate xterm Backspace for Win32 PTYs, and leave Tab completion to PowerShell.
- Win32-OpenSSH SFTP home paths are normalized consistently with other Windows paths.
- SSH clients and jump-host connections are released when context detection fails, a reconnect is canceled, or a Windows compatibility connection closes.
- Repeated reconnect requests no longer start overlapping attempts or revive an explicitly disconnected session.

### Changed

- Removed the experimental RDP connection type so saved connections and session restore remain SSH-only. Legacy RDP entries are ignored during load and export.

## 1.3.23 — 2026-09-13

### Added

- **Windows OpenSSH agent host tools.** Remote `run_command` on Windows now runs in PowerShell at the operator cwd, and file tools resolve `C:\\Users\\...` against Win32-OpenSSH SFTP (`/C/Users/...`). Interactive Windows remotes open PowerShell with OSC 7/133.
- **Legacy SSH host keys.** `ssh-rsa` / `ssh-dss` remain offered so older Windows OpenSSH servers can connect.

## 1.3.22 — 2026-09-12

File explorer sorting + search, toast notifications, transfer ETA, and a UI
polish pass across managers, modals, and the MCP bridge.

### Added

- **File sorting.** The sidebar explorer and both SFTP panes sort by Name,
  Size, Modified, or Type, ascending/descending, with a Folders-first toggle.
  Preferences persist across restarts, and every expanded tree level sorts the
  same way as the root.
- **File search.** Filter-as-you-type (`/` focuses it when the explorer has
  focus) with a live match count; Enter opens the first match, Esc clears.
- **Toast notifications.** Bottom-right transient confirmations (info/ok/err)
  that stack above the status bar and auto-dismiss.
- **Transfer rate + ETA** in the transfers panel.
- **Chrome density setting** (comfortable/compact) for manager, modal, and
  palette spacing.
- **Pinned rows** in Connections, Snippets, and Workspaces, plus
  last-connected timestamps.
- **Reveal in Explorer** for local files from the file tree.
- **Titlebar git badge** backed by a shared live-status hook.

### Changed

- **MCP bridge: per-session transports.** A client that drops and reconnects
  gets a fresh session instead of the hard 400 "Server already initialized"
  (opencode re-initializes on reconnect); bridge requests are capped at 8 MiB.
- **Modal forms** gain dirty-guard discard confirmations, a house footer
  layout, and tooltips with hotkey labels.
- **Hotkey capture** in Settings no longer leaks chords to the terminal/PTY.
- **Packaging** prunes unreadable VCS/sandbox metadata dirs from the file walk.

## 1.3.21 — 2026-09-10

Window and agent management pass: richer pane/tab controls, guarded closes,
first-class window lifecycle, an agent overview cockpit, and fuller session
restore.

### Added

- **Pane and tab context menus.** Pane `⋮` menu (split right/down, equalize,
  merge, close pane) and a tab context menu (rename, split, move to new group,
  close others / to-the-right). Split handles double-click to equalize, and the
  active tab scrolls into view.
- **Agent overview cockpit** (Ctrl/Cmd+Alt+A): show, float, restart, or stop
  every running agent from one surface. Restart is also available from the pane
  cluster and the floating window.
- **Window lifecycle.** Window bounds persistence, dynamic taskbar title,
  single-instance lock, tray reopen, notification click → session focus, and a
  taskbar badge count.
- **Fuller session restore.** Restores browser panes, agent panes, and open
  editors in addition to local shells and saved SSH, and always runs alongside
  auto-launch workspaces. A restore toast summarizes what came back.
- **Local agent activity panel** and local/remote awareness plus persisted
  bounds for the floating agent window.
- **New hotkeys:** `newGroup`, `nextGroup`, `prevGroup`, `splitRight`,
  `splitDown`, `agents`, `toggleGit`.
- **~17 new command-palette actions.**
- **Settings additions:** default-agent picker, and UI for status bar / idle
  detection / scroll speed / terminal background color.

### Changed

- **Guarded closes.** Closing panes/tabs with a running agent, a live process,
  or a dirty editor prompts first; quitting warns about unsaved editors and
  running agents.
- **Approval rules `ask` now actually prompts** under policy mode `full`.
- **Activity log marks `isError` tool results as failures.**
- **Settings modal** gains Escape handling, a focus trap, confirmations for
  destructive resets, and keybinding conflict warnings.
- **Hidden/floating agent attention** is now driven from main (badge from the
  float window, exit badge) so signals are not lost when the agent is not docked.

## 1.3.20 — 2026-09-02

### Changed

- **Quiet terminal chrome.** Titlebar, tabs, buttons, and overlays follow a
  Windows Terminal / Ghostty look: flatter controls, tighter radii, no ambient
  glow on solid themes, and agent chrome uses the theme accent instead of a
  second purple. The default group tab hides when there is only one group.
  Git docks on the right of the terminal with a splitter.
- **Theme-aware status colors.** Danger, success, and tab-status tokens follow
  each theme's ANSI palette. Catppuccin Mocha borders no longer vanish into
  the panel.

### Fixed

- **Docked SFTP shows local and remote.** The side Files view used a 420px
  local column inside a 420px dock, so the remote pane was clipped until a
  window resize. Both machines now share the dock 50/50 from the first paint.

## 1.3.19 — 2026-09-02

### Added

- **Native local agent.** Opening Agent on a local pane uses the CLI's own
  Read/Write/Bash tools in the operator's folder. MCP host tools stay remote-only;
  in-app `browser_*` tools remain on the MCP bridge. Resume keys are per-directory.
- **In-app `browser_*` tools** (11): `browser_list` / `open` / `navigate` /
  `snapshot` / `click` / `type` / `press_key` / `screenshot` / `attach` /
  `detach` / `close`. Agent-owned tabs are freely drivable; operator tabs need
  a one-time attach confirm. `browser_open` splits a pane beside the agent.
- **Visible agent cursor** in the in-app browser: clicks and typing glide a
  branded pointer to the target so you can follow the agent live.
- **Local agent handoff.** Local-only MCP tools `agent_list`, `agent_delegate`,
  and `agent_message` open a visible sibling tab (or split) for another agent,
  preserve the source cwd, and never register on remote bridges.
- **Markdown preview hotkey.** Ctrl/Cmd+Alt+M cycles Edit / Side / Preview for
  Markdown files (editor Side / Preview buttons already existed).

### Changed

- **Open Agent lives on the pane tab strip.** Kind picker (official brand icons)
  + sparkle launch replace the 1.3.18 ask bar. Hide / Float / Stop while the
  agent is running. Process lifetime stays independent of docked / floating /
  hidden. The agent CLI still owns permission prompts (no session Policy picker);
  Settings → Agent guardrails remain an MCP pre-check. First-launch prompts
  (handoff / DevTerm Agent / Pi) still go on the CLI so work starts immediately.
- **In-app browser is first-class.** Pi lists `browser_*` in Available tools
  (`promptSnippet`), local briefings lead with them.
- **Grok native-local isolation.** MCP config lives under `GROK_HOME`, not the
  project tree; local briefing tool prefixes match the Grok MCP names.

### Fixed

- Local `browser_open` no longer times out on an off-screen webview.
- MCP session file for local agents stays in the overlay, not the project tree.
- Bundled Node runtime + offline model catalog for the built-in agent.

## 1.3.18 — 2026-08-23

### Changed

- **Ask bar is the remote agent launch surface.** Kind picker + compose live
  under the shell; Enter/Ask starts the agent. The top bar no longer duplicates
  Open agent / Agent / Policy. While the agent is running it only shows Hide /
  Float / Stop.
- **Permission prompts belong to the agent CLI.** The session Policy picker is
  gone (it did not map onto Claude/Grok/Codex). MCP launches unrestricted;
  Settings approval rules remain a hard pre-check. Claude no longer starts with
  `--dangerously-skip-permissions`; Grok no longer `--always-approve`; Codex no
  longer gets a DevTerm-written `approval_policy`.
- **First DevTerm Agent / Pi prompt** is passed as the CLI message (`pi "…"`)
  so the process starts working instead of opening an empty editor. Follow-ups
  inject into the live PTY after the TUI is idle, with Enter as a separate
  keystroke.

### Fixed

- **Quiet remote inject leftover rows:** POSIX shell-integration restore now
  reclaims the blank lines left under the login prompt instead of leaving a
  gap (still no `clear`, so the MOTD stays).

## 1.3.17 — 2026-08-20

### Added

- **tmux session picker overhaul:** each session shows command, cwd, window list,
  attached/detached state, and a live capture of the active pane so you can see
  what it is doing before attaching.
- **Kill session** from the picker (confirm first); runs `tmux kill-session` on
  an exec channel, not the interactive shell.
- **Reopen the picker** on a live remote: pane tab-strip button, **Ctrl/Cmd+Alt+T**,
  or command palette “tmux sessions…”. Attach while already inside tmux switches
  the existing client (`switch-client`) instead of typing attach into the pane.

### Fixed

- **Remote login flash:** POSIX shell-integration inject was echoed as a long
  command then `clear`ed, so connecting looked like a dump of text that vanished.
  Inject now disables echo first and no longer clears the screen. The same script
  is no longer typed into an existing tmux pane (vim/htop/etc.).

## 1.3.16 — 2026-08-17

### Fixed

- **Stray `]` around remote bash prompts (detached tmux sessions).** The shell
  integration wrapped the prompt's OSC 133 A/B markers in tmux's DCS
  passthrough envelope (`\ePtmux;…`). bash resolves the zero-width `\[`/`\]`
  markers on the literal PS1 text before expanding variable references, so
  baking those marker bytes straight into PS1 made the envelope's terminator
  backslash (`ESC \`) collide with the closing `\]` and print a literal `]`
  next to the prompt. The markers are now applied via deferred `${__dtA}` /
  `${__dtB}` references so bash binds `\[`/`\]` first and injects the bytes
  afterwards — the prompt renders cleanly on every shell, with or without tmux
  passthrough.

## 1.3.15 — 2026-08-10

### Added

- **Agent UI modes:** docked side pane, floating OS window (multi-monitor), or
  hidden — process lifetime is independent of placement. Hide/float/dock do not
  kill the agent; only Stop / tab close / quit do.
- **Ask agent strip** under remote shells: pick backend + policy, type a prompt,
  Ctrl+Enter / Ask starts or reuses the agent and injects into its PTY.
- **Floating agent window** with Dock / Hide / Stop; OS close demotes to hidden.
  Approvals and bridge/PTY events work across main + float windows.
- **Session restore MVP:** optional restore of last groups (local + saved SSH)
  from `userData/session-restore.json` after workspace auto-launch.
- **Import `~/.ssh/config`** into Connections (concrete Hosts only; no passwords).

### Fixed / improved

- Global per-pane **Find** hotkey opens the SearchBar via `openTerminalFind`
  (no longer a no-op when focus is outside xterm).
- Default terminal **scrollback** raised to 10 000 lines.
- `agent:open` is idempotent unless `forceRestart`, so mode switches reattach.

## 1.3.14 — 2026-08-06

### Fixed

- Settings modal scrolling (issue #4): long tabs scroll inside the content body
  instead of overflowing under `overflow: hidden`.

## 1.3.7 — 2026-07-22

### Fixed

- **Windows installer self-false-positive / dirty INSTDIR:** Unlock never kills
  `*setup*` / `*Uninstall*` processes (installer window is not DevTerm). Uses a
  temp PowerShell script (not a fragile one-liner), only targets exact
  `DevTerm.exe` plus processes loaded from a safe install root (leaf name
  `DevTerm`), then wipes that root so extract is not blocked by leftover
  files or stray setup copies under Program Files.

## 1.3.6 — 2026-07-22

### Fixed

- **Windows installer reinstall (elevated / Program Files):** The 1.3.5 close
  hook only ran on the non-elevated outer NSIS process. Assisted all-users
  installs elevate an inner process that stock electron-builder *skips*
  `CHECK_APP_RUNNING` for — so locks were never cleared and extract showed
  "DevTerm cannot be closed" during Installing. Unlock now runs from
  `customInit` (outer + elevated inner), and a failed old uninstaller no longer
  aborts the upgrade.

## 1.3.5 — 2026-07-22

### Fixed

- **Windows installer reinstall:** NSIS no longer gets stuck on "DevTerm is
  running / cannot be closed" when the UI is already closed. The installer now
  force-kills `DevTerm.exe` *and* any process loaded from the install directory
  (bundled agent `node.exe` / PTY children that hold file locks), and continues
  instead of aborting after retries. App quit tree-kills local PTYs so agent
  orphans are less likely to linger.

## 1.3.4 — 2026-07-21

### Fixed

- **Git live status:** Preload `git:on-change` subscriptions now use matching
  send/on channels so the 5s poll/push actually runs (StatusBar / Git panel).
- **SOCKS5 dynamic (-D) forwards:** Handshake tracks greeting vs CONNECT across
  TCP segments so well-behaved clients no longer get protocol-corrupted drops.
- **SSH reconnect:** Port forwards suspend and rebind after transport recovery;
  SFTP watches tolerate transient poll failures; reconnect keeps a profile
  tombstone so "Reconnect now" still works; operations during reconnect reject
  with a clear error instead of TypeError.
- **PTY id-reuse race:** Agent auto-restart no longer lets a zombie `onExit`
  delete the live PTY from the map.
- **Git log / status:** Per-file history puts the revision before `-- path`;
  conflict badges use real unmerged codes only (no false AM/AD conflicts);
  status cache races and poll re-entrancy fixed.
- **Local global search:** Output is indexed under the session id (not raw PTY
  id) so hits jump correctly; exit clears the index.
- **Transfers:** In-flight cancel no longer double-finishes; flush is serialized;
  finished history is capped; quit awaits transfer/settings/search flush.
- **MCP / agent:** Capped remote `read_file` reads; policy ignores `2>&1` as
  mutation; bridge recovers from sticky `error` state; pending confirms cleaned
  on session close; launches serialized; rate-limit failover cursor resets.
- **Renderer:** Orphan SSH disconnect on connect race; StatusBar effect deps;
  terminal input during PTY startup; Settings dialog a11y; STT capture cleanup
  and stale transcript guard; createGrid partial remote failure handling.
- **Packaging / setup:** Exclude unused onnxruntime-node/sharp from installer;
  per-platform node-pty prebuild rules; setup-native ABI detection + integrity pin.

### Security

- **SSH TOFU:** First-use host keys prompt with fingerprint before trust.
- **Markdown preview:** Heading ids only; `id` stripped from other elements to
  reduce DOM clobbering risk.

## 1.3.3 — 2026-07-20

### Added

- **Bundled DevTerm Agent (default):** The primary coding agent is now the
  multi-provider runtime packaged with the app (`@earendil-works/pi-coding-agent`
  + a dedicated Node binary). External CLIs (`pi`, `claude`, `opencode`, `kimi`,
  `grok`, `codex`) remain selectable fallbacks. Default `agentKind` is `devterm`.
- **Provider / model routing:** Settings → DevTerm Agent exposes provider and
  model preference, ordered rate-limit fallbacks (`provider/model` pairs), and a
  resume-sessions toggle. Model credentials stay in the agent's own auth store or
  environment — they never cross DevTerm IPC.
- **Authenticated-provider status:** `agent:capabilities` reports runtime version,
  offline model catalog, and whether each provider has configured auth (presence
  only; no secret values).
- **Automatic rate-limit recovery:** On HTTP 408 / 429 / 5xx from the active
  provider, the MCP extension switches the next request to the next authenticated
  fallback model.
- **Resumable agent sessions:** Optional transcripts under
  `userData/agent-sessions/`, keyed by remote session id, reopen after reconnect
  when resume is enabled.
- **Pinned instruction skills:** Users can allowlist instruction-only skill files
  with a SHA-256 pin re-checked at every launch. Executable third-party extensions
  remain disabled.
- **Performance panel:** On-demand local process CPU/memory snapshot via
  `performance:snapshot` (Settings → Performance). Nothing is sampled in the
  background or uploaded.
- **Remote detached sessions setting:** When enabled (default), POSIX remotes
  with tmux reattach a stable `devterm-<sessionId>` tmux session across SSH
  reconnects.

### Changed

- **Packaging:** `electron-builder.yml` unpacks the bundled Node binary, the
  agent package, and its runtime dependency closure so the agent can run from
  the installed app outside `app.asar`.
- **AGENTS.md:** Expanded project map for other coding agents — architecture
  table, agent launch matrix, MCP tool list, persistence, packaging unpack rules,
  and 1.3.x release context. Version stamp set to 1.3.3.

## 1.3.2 — 2026-07-16

### Fixed

- **Command Palette — History:** PSReadLine multi-line commands no longer
  fragment into concatenated junk rows (e.g. `cd D:\projects\my-termD:\projects\my-term`).
  The history reader now reassembles PSReadLine's trailing-backtick continuations
  into one record per command, and dedupe is keyed on a normalised form so
  casing / quoting / trailing-path-separator variants collapse to a single row.
- **Global Search:** Result rows no longer render the terminal's raw ANSI/VT
  sequences (`[93m`, `[23;20H`, `]7;file://…`, OSC 7 / OSC 133 prompt hooks).
  The search index now strips escape sequences and C0 controls at ingest, so
  stored lines and the rows the modal shows are plain text.
- **Transfer Queue (boot crash):** `TransfersPanel` no longer crash-loops the
  app on launch with React error #185. `selectVisible` returns a fresh array
  each snapshot read; wrapping the subscription in `useShallow` keeps referential
  equality on the unchanged result.
- **Settings → Remote sessions (boot crash):** Same React #185 fix for the
  `useSessions((s) => s.sessions.filter(...))` subscription in `SettingsModal`.
- **Agent Activity export:** Replaced a DOM `data-attribute` hack (which leaked
  between agent panes) with proper React state; success and failure both show
  an inline auto-dismissing message, and the time row now renders a localised
  formatted time instead of the raw ISO string.
- **Browser Pane — DevTools button:** The `⌘ DevTools` label only shows on
  macOS now; Windows / Linux render `DevTools` so the misleading glyph is gone.
- **File Pane:** A `loading…` placeholder renders before the first listing
  arrives instead of a blank area for files at depth > 0.

### Added

- **One-time welcome hint:** A non-modal "Getting started" card anchored
  bottom-center of the panes area surfaces the user's actual (possibly
  overridden) keybindings for the command palette, new terminal, and settings
  on first run. Dismissed via the × button; the choice is persisted and not
  resurrected by a settings import.
- **`ConfirmDialog` component:** New reusable danger / primary confirm dialog
  in `components/common`. Replaces `window.confirm()` in the Git branches,
  changes, stash, and tags panels so destructive actions get the house
  modal styling, autofocus, and Esc-to-close.
- **`useEscapeKey` hook:** Tiny window-level Esc-to-close helper for modals
  that render outside `ModalShell` (file diffs, command palette, new-tab
  picker, save-workspace, shortcuts, agent-approval). One helper, one
  behaviour, no more per-component key handlers.
- **`formatBytes` helper:** Centralised byte-count formatter; was duplicated in
  `BrowserPane` and `PortForwardPanel`.
- **Transfers panel error reason:** Failed transfers now show the error text
  inline (truncated with tooltip) instead of only an `error` status pill.

### Accessibility

- **Pane tabs:** Added `role="tablist"` / `role="tab"`, `aria-selected`, and
  keyboard activation (Enter / Space) on the tab itself. The close button is
  now a real `<button>` with `aria-label="Close tab"`.
- **Modals:** `ModalShell`, `CommandPalette`, `GlobalSearchModal`,
  `ConfirmActionModal`, `ShortcutsModal`, and `NewTerminalModal` now expose
  `role="dialog"` + `aria-modal`; titles are linked via `aria-labelledby`.
- **Command palette:** History rows surface the full command in a `title`
  tooltip so mouse users can read commands that overflow the row.
- **Confirm-action modal:** Focuses the safe default (`Deny`) on every new
  request; Left/Right arrow keys cycle the focused button; uses the standard
  `danger` / `ghost` classes instead of the old bespoke `danger-btn`.

### Changed

- **Reduced motion:** The reconnect banner pulse, browser-progress pulse, and
  terminal bell-flash now respect `prefers-reduced-motion: reduce` (the bell
  flash is disabled outright, the others animate only when motion is OK).
- **Theme tokens:** `--font-mono` / `--font-ui` are now CSS variables,
  referenced from the global-search modal and other mono-data surfaces.
- **Approval rules, transfer queue, git panel, shell picker, terminal chrome:**
  Hardcoded greys / reds were replaced with theme tokens (`--danger`,
  `--ok`, `--status-warn`, `--shadow-2` flat forms) so dark themes like
  gruvbox and ayu no longer wash out.
- **Hotkey label:** `palette` description shortened to "Command palette"
  (the "(run a snippet)" suffix was misleading — it runs whatever the
  chosen category dispatches, not snippets specifically).
- **`AGENTS.md`:** Slimmed from a 426-line manual to a 97-line feature index
  (architecture, terminals & layout, files, browser, agent bridge, persistence,
  commands, packaging, critical rules). Full per-feature behaviour lives in
  the code where it can stay current.

## 1.3.1 — 2026-07-15

### Fixed

- **STT/Dictation:** Worker crash no longer leaves a dead reference that traps the
  download UI in "loading" forever. Stale `ready` messages from a previous model
  load are discarded. The `transcribe` request now carries the correct `modelId`
  so the worker loads the exact model the user selected.
- **STT/Dictation:** Push-to-talk shortcut now properly cancels a pending mic
  request if the key is released before the permission dialog resolves.
- **STT/Dictation:** Audio capture no longer leaks the mic stream when
  `AudioContext` or `audioWorklet.addModule()` throws.
- **Browser Downloads:** `broadcast()` is now throttled to 150 ms, eliminating
  IPC/render thrashing and the wobbly progress-bar flicker.
- **Browser Downloads:** `browserZoomReset` no longer resets the main DevTerm
  window zoom.
- **Browser Downloads:** Completed downloads are evicted after 5 min; cancelled /
  interrupted downloads are evicted immediately.
- **Transfer Queue:** `done` events are now merged atomically into the renderer
  store, eliminating the backward-then-forward progress jump.
- **Transfer Queue:** Canceling an active item now transitions the store
  immediately to `done/canceled` instead of waiting for the stream to error out.
- **Transfer Queue:** Full-list re-renders are only sent on `done` events, not
  on every 250 ms progress tick.
- **Transfer Queue:** `clearFinished` now broadcasts to all windows.
- **Transfer Queue:** `selectVisible` now actually filters to the last 24 hours.
- **Transfer Queue:** Action buttons now use the computed `status` consistently.
- **Settings:** Custom keybinding single-character keys are normalized to lowercase.
- **Settings:** `applyImported` now validates all fields through the same
  normalizers used at load time.
- **Sessions:** `activeId` orphan race after closing a pending SSH tab is fixed.
- **Sessions:** `setActive` rejects invalid session IDs.
- **Sessions:** SSH `onStatus` listeners are now disposed on session close.
- **Sessions:** `connectSsh` no longer steals focus if the user switched away.
- **Layout:** `activeLeaf` is recomputed when a leaf is pruned, preventing empty panes.
- **Layout:** Resize clamping now uses a loop so both sides stay above the minimum.
- **Layout:** `computeLayout` handles malformed `sizes` arrays and zero-total cases.
- **Layout:** `setActiveGroup`, `setActiveTab`, and `focusLeaf` now validate their inputs.
- **Hotkeys:** `nextTab`/`prevTab` now cycles only within the current leaf's tabs.
- **Hotkeys:** `Ctrl+Plus` (numpad +) now zooms in alongside `Ctrl+Shift+Plus`.
- **Hotkeys:** `Tab` is no longer blocked from custom keybinding capture.
- **App:** `Escape` no longer swallows custom keybindings before `matchHotkey` runs.
- **App:** Added a guard so most shortcuts don't fire while typing in an editor.

## 1.1.1 — 2026-07-09

### Fixed

- Opening a file from the explorer no longer traps you in the full-view editor.
  The Terminals / file tab strip is shown above the editor again so you can
  return to the terminal workspace or close documents.

## 1.0.4 — 2026-07-09

### Changed

- Session tabs summarize long shell commands and agent tool activity (heredocs,
  pipelines, `key=value` bridge dumps) so the tab strip stays readable.
- Busy tabs are width-capped with ellipsis so one long title cannot dominate
  the strip.

## 1.0.3 — 2026-07-08

### Fixed

- Terminal scrollbar is now interactive. The canvas renderer's
  `.xterm-screen` overlay was swallowing clicks meant for the viewport's
  scrollbar thumb; it now passes pointer events through so the scrollbar can
  be dragged.

### Changed

- Status bar layout refinements and cleaner right-side status cells.

## Foundation (cluster gate) — 2026-06-12

Shared foundation that the rest of the cluster work (A/B/C/D/E) imports.
No user-visible features yet; this only adds the data layer and IPC
surface other tracks will build on.

### Types (additive, in `src/shared/types.ts`)

- `TerminalBg`, `TerminalPrefs`, `AutoReconnectPrefs` — promoted from the
  renderer settings store so the main process can serialize them too.
- `SettingsSnapshot { themeId, terminalBg, prefs, autoReconnect }` — a
  self-contained snapshot suitable for export/import.
- `ApprovalRule { id, sessionId?, commandPrefix, outcome, createdAt }` —
  command-prefix approval for the agent guardrail.
- `BridgeActivityKind` / `BridgeActivityEntry { id, sessionId, kind, tool?,
  detail, ts, durationMs?, ok? }` — per-session event log entries.
- `PortForwardKind` / `PortForward { id, sessionId, kind, localPort,
  remoteHost?, remotePort?, createdAt, bytes? }` — SSH port forwards
  (`-L` and `-D`).
- `TabStatus = 'normal' | 'reconnecting' | 'disconnected' | 'agent_pending'
  | 'error'` — the per-tab status badge the agent pane will drive.
- `QuickConnectEntry { host, port, username, lastUsedAt }` — recent-host
  autocomplete data.
- `TransferItemV2 { id, direction, localPath, remotePath, total, transferred,
  done, error?, canceled?, enqueuedAt, finishedAt? }` — richer transfer
  row used by the new queue UI.
- `SettingsExportBundle { version: 1, exportedAt, settings, snippets,
  connections, workspaces, approvalRules }` — the versioned export shape.

### IPC surface (additive, in `src/preload/index.ts`)

- `window.devterm.bridgeActivity.{on,list,clear}` — per-session log
  subscription + history read.
- `window.devterm.settingsIo.{export,import}` — both pop a native file
  dialog.
- `window.devterm.approvalRules.{list,add,remove,match}` — single action
  channel; `match` returns the longest-prefix rule for a command.
- `window.devterm.portForward.{list,add,remove}` — `list` is live;
  `add`/`remove` throw `Error('portForward not implemented yet')` until
  Cluster B wires them to the ssh2 client.

### Main-process modules

- `src/main/bridge-activity.ts` — ring buffer (500 entries per session)
  with a JSONL tail file (`userData/bridge-activity.jsonl`, rotated at
  5000 lines). Subscriber bus for live events. No MCP wiring — the data
  layer only.
- `src/main/approval-rules.ts` — CRUD + longest-prefix match with a
  token-boundary check. Persisted atomically in
  `userData/approval-rules.json`.
- `src/main/settings-io.ts` — `exportAll` / `importAll` /
  `exportToPath` / `importFromPath`. Strips `password`, `passphrase`, and
  `privateKeyPath` from every exported connection (top level + nested
  `jump` bastion hop). Atomic `.tmp + rename` writes match the existing
  snippets/workspaces style.
- `src/main/foundation-ipc.ts` — registers the new channels in one place
  and exposes `recordBridgeActivity()` so the agent bridge can record +
  push events to the renderer without depending on Electron internals.
