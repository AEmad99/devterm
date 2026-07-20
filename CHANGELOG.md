# Changelog

All notable changes to DevTerm are documented here. The most recent section is
at the top. Dates are ISO `YYYY-MM-DD`.

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
