---
name: package-win
description: Build the DevTerm Windows NSIS installer. Use when the user wants to package/release a Windows build.
disable-model-invocation: true
---

Produce the Windows installer for DevTerm.

1. Confirm `npm run setup` has been run at least once (the Electron binary + node-pty prebuilt must be present). If `node_modules` or the prebuilt look missing, run `npm run setup` first.
2. Run `npm run build:win` — this does an electron-vite build followed by electron-builder (NSIS, x64, unsigned). Output lands in the electron-builder `dist` directory.

Reminders specific to this repo (surface these if the build fails):
- **node-pty must stay `asarUnpack`'d** (configured in `electron-builder.yml`). If the packaged app crashes loading the PTY native module, the unpack rule was likely removed.
- The build is **unsigned**; Windows SmartScreen warnings on the installer are expected.
- `npm run release:win` publishes to GitHub and needs `GITHUB_TOKEN` in `.env` (git-ignored) — only run it if the user explicitly asks to publish a release.

Report the path to the generated installer when done. If the build fails, show the error and stop.
