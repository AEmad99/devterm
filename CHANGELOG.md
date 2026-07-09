# Changelog

All notable changes to DevTerm are documented here. The most recent section is
at the top. Dates are ISO `YYYY-MM-DD`.

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
