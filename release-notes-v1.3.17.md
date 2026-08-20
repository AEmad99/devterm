## DevTerm v1.3.17

### Added

- **Richer tmux session picker.** Existing sessions show the running command,
  working directory, window list, attached/detached state, and a live preview of
  the active pane so you can see what each session is doing before you attach.
- **Kill session** from the picker (with confirmation). Destroyed via
  `tmux kill-session` on a dedicated exec channel — it is not typed into the
  live pane.
- **Reopen the picker** on an already-connected remote:
  - grid icon on the remote pane tab strip
  - **Ctrl+Alt+T** (Cmd+Alt+T on macOS)
  - command palette → “tmux sessions…”

  If you are already inside tmux, attaching another session uses
  `tmux switch-client` instead of sending `tmux attach` as keystrokes.

### Fixed

- **Remote terminals no longer flash a wall of script then clear.** Connecting
  used to echo the shell-integration inject and run `clear`, wiping the login
  banner. Inject now runs with echo off and leaves the screen alone. Existing
  tmux panes are not injected into (so vim/htop are not overwritten).

### Installer

- `DevTerm-1.3.17-setup.exe` (Windows x64, NSIS, unsigned) + differential
  update metadata (`latest.yml`, `.blockmap`).
