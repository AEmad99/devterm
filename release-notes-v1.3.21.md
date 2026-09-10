## DevTerm v1.3.21

Window and agent management pass: richer pane/tab controls, guarded closes,
an agent overview cockpit, and fuller session restore.

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
- **Local agent activity panel**, plus local/remote awareness and persisted
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

### Installer

- `DevTerm-1.3.21-setup.exe` (Windows x64, NSIS, unsigned) + differential
  update metadata (`latest.yml`, `.blockmap`).
