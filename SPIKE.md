# Electron major-upgrade spike

**Branch:** `spike/electron-upgrade`  
**Date:** 2026-09-21  
**Baseline:** DevTerm `package.json` `1.3.30` on Electron `^29.4.6`  
**Do not merge until natives and packaged agent boot are proven.** Electron 29 stays on `main`.

This is investigation only. No dependency bumps on `main`.

---

## Why this is a project, not a version bump

DevTerm's process model is unusual for Electron apps:

- Every terminal stays mounted (PTY/SSH lifetime ≠ UI). Hidden groups hibernate **renderer xterm surfaces**, not processes.
- Local shells use **prebuilt node-pty** (`npm:@homebridge/node-pty-prebuilt-multiarch@0.13.1`) plus in-box ConPTY on Windows. `npm rebuild` of node-pty is forbidden.
- The bundled DevTerm Agent is a **separate Node binary** that must resolve `@earendil-works/pi-coding-agent` **and** its nested `node_modules` from `app.asar.unpacked`.
- In-app browser panes are `<webview>` guests on `persist:browser`, hardened in `src/main/index.ts`.

An Electron major that moves Chromium, Node ABI, or asar layout can break all four at once.

---

## 1. node-pty ABI

**Current:** `node-pty` is aliased to `@homebridge/node-pty-prebuilt-multiarch@0.13.1`. Windows ConPTY addons live in `node-pty/build/Release/` (`conpty.node`). The npm package `files` field omits `build/`; `scripts/before-pack.cjs` patches that in, and `scripts/after-pack.cjs` fails the Windows build if natives are missing.

**Risks of Electron 30+ / 32+ / 33+:**

| Item | Why it matters |
| --- | --- |
| NODE_MODULE_VERSION | Prebuilt `.node` files are ABI-locked. Homebridge prebuilds must ship a binary for the **Electron Node ABI**, not stock Node. |
| Vendored `OpenConsole.exe` | DevTerm already avoids bundled OpenConsole on current Windows 11 (`DEVTERM_USE_BUNDLED_CONPTY=1` is diagnostic-only). A pty upgrade that forces the helper back is a regression. |
| `@homebridge/node-pty-prebuilt-multiarch` vs upstream `node-pty` | Upstream often lags Electron; homebridge exists because of that. Confirm a prebuild exists **before** bumping Electron. |

**Spike work still required (not done here):**

1. Map target Electron version → Node ABI (`process.versions.modules` in that Electron).
2. Check whether homebridge `0.13.x` or a newer tag publishes `win32-x64` for that ABI.
3. `npm run setup` on the spike branch; spawn a local PTY (`node scripts/smoke.cjs`).
4. Packaged boot: NSIS build must still contain `conpty.node` under `app.asar.unpacked`.

If no prebuild exists, options are: stay on Electron 29, vendor ConPTY ourselves, or wait. Do not `npm rebuild` node-pty as a workaround — that compiles against the **system** Node, not Electron.

---

## 2. `<webview>`

**Current:** `webviewTag: true`, partition `persist:browser`, preload stripped, `nodeIntegration: false`, navigation locked to http(s)/about:blank, certificate prompts, de-Electroned UA.

**Risks:**

- Electron 30+ tightened webview/guest view APIs; some `will-navigate` / `setWindowOpenHandler` behavior moved.
- Isolated world / preload-on-guest changes can re-expose Node if a guest preload sneaks back.
- Chromium partition persistence (`persist:browser`) usually survives, but zoom (`userData/browser-zoom.json`) and download `will-download` hooks must be re-verified.
- Agent browser control (`BrowserControlService` + `webContents.executeJavaScript` / `capturePage`) depends on guest `webContentsId` remaining stable after `dom-ready`.

**Spike work still required:**

- `npm run dev` with a browser pane: navigate, new tab, download, zoom, find-in-page.
- Agent `browser_open` / `browser_snapshot` / `browser_screenshot` against a local page.
- Preview pane (same webview stack) with overlay comments.

---

## 3. asarUnpack + agent nested `node_modules`

**Current packing (do not “clean up” without a packaged boot probe):**

- `asarUnpack` includes `node-pty`, `**/*.node`, `node/bin/**`, `@earendil-works/**`, nested `pi-coding-agent/node_modules/**`, hoisted MCP sdk + zod, `ort/*.wasm`.
- `scripts/after-pack.cjs` mirrors `node_modules/@earendil-works/pi-coding-agent/node_modules/` into `app.asar.unpacked` because electron-builder collection drops nested-only deps the **external** agent Node needs.
- `scripts/agent-closure-pack.cjs` is part of that closure story.

**Risks:**

- Newer electron-builder / asar may change how nested `node_modules` are collected.
- Electron major often forces an electron-builder bump; that is how v1.3.25/1.3.26 ConPTY and v1.3.29 nested-closure bugs were introduced.
- The agent Node binary (`node/bin/**`) must remain executable **outside** asar.

**Spike work still required:**

1. Produce `npm run build:win` on the spike branch (`CSC_IDENTITY_AUTO_DISCOVERY=false` if winCodeSign symlink issues).
2. Confirm `app.asar.unpacked/node_modules/node-pty/build/Release/conpty.node` exists.
3. Confirm nested `pi-coding-agent/node_modules` is present next to the agent binary.
4. Launch packaged app, start DevTerm Agent locally, confirm no `ERR_MODULE_NOT_FOUND`.

---

## 4. `npm run dev` smoke

Minimum unpackaged checks after an Electron bump:

```sh
npm install --ignore-scripts
npm run setup
npm run typecheck
npm run test
npm run test:grid
node scripts/smoke.cjs
npm run dev
```

Manual in `npm run dev`:

- Local PTY (PowerShell) starts without OpenConsole.
- One SSH session (agent auth or key).
- Hide a second group 45s → xterm hibernates, PTY lives, replay on return.
- Open bundled agent; `browser_open` a tab.
- Quit with tray setting **off** (process dies).

`electron . --self-test` is the deeper headless check (needs a build, 90s watchdog). Do not treat unpackaged `dev` as proof of packaged agent boot.

---

## Recommended target (when work resumes)

Do **not** jump multiple majors in one PR. A realistic next experiment is **Electron 32 or 33 LTS-equivalent**, only if:

1. homebridge (or a documented ConPTY prebuild) matches that ABI on win32-x64,
2. `<webview>` guest hardening still holds,
3. a Windows NSIS build boots a local PTY **and** the bundled agent.

Until then, Electron 29 on `main` is the product.

---

## Out of scope on this branch

- Bumping `package.json` electron / electron-builder / node-pty
- macOS notarization
- WebGL terminal renderer
- Merging to `main`
