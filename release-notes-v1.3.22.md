## DevTerm v1.3.22

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

### Installer

- `DevTerm-1.3.22-setup.exe` (Windows x64, NSIS, unsigned) + differential
  update metadata (`latest.yml`, `.blockmap`).
