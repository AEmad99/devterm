## DevTerm v1.3.30

Stabilizes Windows PTY teardown so SSH-backed agent sessions do not surface a
main-process JavaScript error or appear to lose their connection.

### Fixed

- Use Windows' in-box ConPTY by default instead of node-pty's bundled
  `OpenConsole.exe`, which was observed crashing with an access violation during
  teardown.
- Remove exited PTYs from the manager before invoking cleanup callbacks, so
  callbacks cannot ask node-pty to kill an already-closed console.
- Keep the bundled ConPTY path available only through the explicit
  `DEVTERM_USE_BUNDLED_CONPTY=1` diagnostic opt-in.
- Make the bundled-agent ConPTY self-test robust to ANSI terminal bytes before
  the printed version.

### Installer

- `DevTerm-1.3.30-setup.exe` (Windows x64, NSIS, unsigned) plus differential
  update metadata.
