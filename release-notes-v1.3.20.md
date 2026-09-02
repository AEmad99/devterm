## DevTerm v1.3.20

Quiet terminal chrome plus a docked SFTP layout fix.

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

### Installer

- `DevTerm-1.3.20-setup.exe` (Windows x64, NSIS, unsigned) + differential
  update metadata (`latest.yml`, `.blockmap`).
