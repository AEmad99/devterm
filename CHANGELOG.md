# Changelog

All notable changes to DevTerm are documented here. The most recent section is
at the top. Dates are ISO `YYYY-MM-DD`.

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
