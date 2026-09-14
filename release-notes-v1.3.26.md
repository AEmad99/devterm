## DevTerm v1.3.26

Hotfix for packaged Windows builds: local terminals and every agent backend
failed to start on v1.3.25 with `Cannot find module '../build/Release/conpty.node'`.

### Fixed

- **node-pty ConPTY natives.** The installer now ships `conpty.node` (and the
  rest of `node-pty/build/Release`) outside `app.asar`. v1.3.25 packed
  node-pty's JavaScript but dropped the native addons because the npm package's
  `files` field does not list `build/`. Packaging patches that list and refuses
  to produce a Windows build if the natives are missing.

### Installer

- `DevTerm-1.3.26-setup.exe` (Windows x64, NSIS, unsigned) + differential
  update metadata (`latest.yml`, `.blockmap`).
