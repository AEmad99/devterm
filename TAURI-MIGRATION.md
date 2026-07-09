# DevTerm → Tauri (Windows-native) Migration Plan

**Status:** Draft plan (not yet in progress)  
**Date:** 2026-07-08  
**Goal:** Replace Electron with Tauri 2 on Windows (WebView2), keep product shape, and make the host stack native (small binary, OS window chrome, Rust host services).

---

## 1. What “Windows native” means here

DevTerm already behaves like a normal Windows app in one important way: **framed window, no fake titlebar, OS Snap Layouts**. That must stay.

| Layer | Electron today | Target under Tauri |
| --- | --- | --- |
| Shell | Chromium + Node main | **WebView2** host + **Rust** backend |
| UI | React / xterm / CodeMirror | **Keep** (Vite-built web UI) |
| Host I/O | Node (`node-pty`, `ssh2`, fs, HTTP MCP) | **Rust crates** (or carefully scoped FFI) |
| IPC | `preload` + `contextBridge` + `ipcMain` | Tauri **commands** + **events** |
| Packaging | NSIS via electron-builder | **MSI/NSIS or MSIX** via Tauri bundler |
| Updates | `electron-updater` | Tauri updater (signed preferred) |

“Native” does **not** mean rewriting the terminal UI in WinUI/WPF. That would throw away xterm, layout, and agent UX for little product gain.

Native means:

- OS-owned window chrome and materials (optional Mica/Acrylic later)
- No bundled Chromium (large binary/RAM savings)
- Host capabilities in Rust with proper process isolation
- Windows packaging and install/update that fits GitHub releases (and optionally Store/MSIX later)

---

## 2. Current architecture (what must move)

```
Renderer (React)  --preload DevTermApi-->  Main (Node/Electron)
                                              ├─ PtyManager (node-pty / ConPTY)
                                              ├─ SSHManager (ssh2, TCP_NODELAY)
                                              ├─ SFTP / watches / transfers
                                              ├─ Local fs + watches
                                              ├─ MCP HTTP bridge + agent launch
                                              ├─ Persistence (userData JSON + safeStorage)
                                              ├─ Browser guests (<webview> + session)
                                              └─ Auto-updater
```

### High reuse (~60–70% of product value)

- `src/renderer/**` — layout, sessions store, xterm, files UI, agent pane UI, themes
- `src/shared/types.ts` — **contract shape** (rewrite as shared TypeScript types + Rust serde mirrors)
- Product rules from `AGENTS.md` / `Claude.md`:
  - Keep terminals mounted; hide with CSS
  - Stable xterm DOM slots (no reparent)
  - One SSH client per session (shell, SFTP, watches, exec, agent tools)
  - OSC 7 cwd tracking
  - `FsApi.watch()` for live listings
  - MCP policy boundary
  - Agent terminal output is not application state
  - Theme CSS variables; no motion on xterm geometry
  - Framed BrowserWindow / OS owns snap

### Full rewrite

- Entire `src/main/**` (Electron/Node)
- `src/preload/**`
- electron-vite / electron-builder / node-pty packaging and `asarUnpack`

### Hard product risk

- **In-app browser pane** (`BrowserPane` + `<webview>` + partition hardening) has no 1:1 Tauri equivalent

### Code map (Electron → Tauri owner)

| Area | Electron code | Tauri target |
| --- | --- | --- |
| App entry / window | `src/main/index.ts` | `src-tauri/src/main.rs` + window config |
| Shared contracts | `src/shared/types.ts` | Keep TS; mirror serde types in Rust |
| Preload API | `src/preload/index.ts` | Thin `window.devterm` adapter over `invoke`/`listen` |
| Local PTY | `src/main/pty/manager.ts` | Rust ConPTY / portable-pty crate |
| SSH / SFTP | `src/main/ssh/*` | russh (+ SFTP) shared client |
| Files / watches | `src/main/fs/*`, `src/main/ssh/watch.ts` | `tokio::fs` + `notify` + SFTP poll |
| Transfers | `src/main/transfer.ts`, `transfers/*` | Rust transfer queue + events |
| Agent + MCP | `src/main/agent/*`, `src/main/mcp/*` | Rust MCP HTTP + tool handlers + launch prep |
| Persistence | connections/workspaces/snippets/settings IPC | App data dir JSON + DPAPI secrets |
| Browser pane | `BrowserPane.tsx`, `src/main/ipc/browser.ts` | Deferred or custom WebView2 embed |
| Updater | `src/main/updater.ts` | Tauri updater plugin |
| Packaging | `electron-builder.yml` | `tauri.conf.json` + bundler |

---

## 3. Target architecture

```
┌─────────────────────────────────────────────────────────┐
│  WebView2 (React app)                                   │
│  window.devterm ≈ invoke() + listen() adapter           │
└───────────────────────────┬─────────────────────────────┘
                            │ Tauri IPC
┌───────────────────────────▼─────────────────────────────┐
│  Rust core (tauri::Builder)                             │
│  ┌─────────────┐ ┌────────────┐ ┌─────────────────────┐ │
│  │ pty crate   │ │ ssh crate  │ │ fs / watch / dialog │ │
│  │ (ConPTY)    │ │ (russh)    │ │                     │ │
│  └─────────────┘ └─────┬──────┘ └─────────────────────┘ │
│                        │ shared Client                  │
│  ┌─────────────────────▼──────────────────────────────┐ │
│  │ sftp · exec · port-forward · remote watch · MCP    │ │
│  └────────────────────────────────────────────────────┘ │
│  agent: spawn CLI in local PTY + loopback MCP HTTP      │
│  secrets: DPAPI / Windows Credential Manager            │
│  persistence: %APPDATA%\DevTerm\*.json                  │
└─────────────────────────────────────────────────────────┘
```

### IPC strategy (preserve the API shape)

Today the renderer depends on a typed `DevTermApi` (`window.devterm.*` in `src/shared/types.ts` and `src/preload/index.ts`). Do **not** scatter raw `invoke('random_string')` through React.

1. Keep `DevTermApi` as the renderer contract.
2. Implement a thin adapter:

   ```ts
   // pseudo
   pty.create(opts) → invoke('pty_create', opts)
   pty.onData(id, cb) → listen(`pty:data:${id}`, cb)
   ```

3. Mirror every channel in `src/shared/types.ts` as Tauri command names + event names.
4. Hand-maintain (or generate) Rust request/response types from the same shapes (zod/validation on the TS side where useful; serde on Rust).

This keeps `TerminalView`, `RemoteSessionView`, `FsApi`, `AgentPane`, and layout stores almost unchanged.

### Streaming data (PTY / SSH)

Electron uses high-volume `webContents.send` for terminal bytes. Tauri events work, but watch for:

- Event coalescing under load (reimplement patterns from `src/main/ipc/coalesce.ts` in Rust)
- UTF-8 split across packets (the ssh2 path already decodes carefully; do the same in Rust)
- Backpressure if the frontend stalls

For interactive feel, keep **TCP_NODELAY** on SSH sockets and avoid buffering full lines in the host.

---

## 4. Capability-by-capability migration map

### 4.1 Local PTY (critical path)

| Today | Target |
| --- | --- |
| `@homebridge/node-pty-prebuilt-multiarch` | Windows **ConPTY** via `portable-pty` / ConPTY crates or a thin `windows` crate wrapper |
| PowerShell default + OSC 7 prompt injection | Port shell selection + prompt injection as strings written after spawn (or shell profile template) |
| Agent CLIs in node-pty | Same PTY manager; explicit argv must still skip prompt injection |

**Work items**

- Commands/events: `pty_create` / `input` / `resize` / `kill` / `data` / `exit` / startup-failure detection
- Prefer ConPTY (Windows Terminal lineage), not winpty
- Validate: interactive shells, resize, Unicode, `pi` / `claude` / `opencode` (and other) TUIs, clean exit / EPIPE handling

This is the first vertical slice that proves Tauri is viable for DevTerm.

### 4.2 SSH / SFTP / remote shell (critical path)

| Today | Target |
| --- | --- |
| `ssh2` one client per session | **`russh` + SFTP support**, one session struct owning the client |
| Custom TCP dial + `setNoDelay(true)` | Same: open `TcpStream`, set nodelay, hand to russh |
| Known hosts TOFU in userData | Port algorithm (reject mismatch); store under Tauri `app_data_dir` |
| Shell + SFTP + exec + port-forward + agent tools | All share that client — **non-negotiable product rule** |

**Work items**

- Connection lifecycle, status events, reconnect policy
- Shell open / resize / input / data / exit
- SFTP list / read / write / mkdir / rename / delete + poll watch
- Transfer queue with progress events
- Port forwards if the feature is kept

**Risk:** ssh2 edge cases (auth methods, key formats, agent, unusual servers) need a compatibility matrix and tests against real hosts.

### 4.3 Local filesystem

Straightforward Tauri/Rust:

- `std::fs` / `tokio::fs`
- Directory watch: `notify` crate (+ poll fallback like today)
- File size limits for editor (`MAX_EDIT_BYTES`)
- Native open/save dialogs via Tauri dialog plugin

### 4.4 Persistence and secrets

| Store | Today | Target |
| --- | --- | --- |
| connections / workspaces / snippets / settings | JSON in Electron `userData` | JSON in Tauri app data dir (same filenames = easier migration) |
| connection secrets | Electron `safeStorage` | **Windows DPAPI** or Credential Manager |
| import / export | dialogs + encrypted payload | same UX; versioned export format |

**Migration requirement:** On first Tauri launch, if Electron userData exists, offer import.

**Important:** Electron `safeStorage` blobs are **not** portable without an export path from the Electron build. Prefer:

1. Ship a versioned export in the current Electron app (decrypts secrets into a portable import format), **before** cutover.
2. Document that users should export while still on Electron if they need password migration.

### 4.5 Agent bridge + MCP (high complexity, high value)

Keep the product model:

1. Loopback MCP HTTP server (`127.0.0.1:<random-port>` + bearer token)
2. Temp work dir with briefing + per-agent config
3. Spawn agent CLI in a **local** PTY
4. Tools execute over the **shared SSH client**
5. Policy modes: `read_only` / `confirm` / `full`
6. Bridge status from real MCP traffic + heartbeat

| Piece | Target |
| --- | --- |
| MCP server | Rust HTTP (`axum` / `hyper`) implementing the streamable HTTP MCP subset we need |
| Tool handlers | Call into SSH / fs managers |
| Policy + confirm | Same rules; confirm → event to UI → command reply |
| Launch layers | Port path / env / arg construction for each agent kind |
| pi extension TS | Still write files to temp dir; no need to rewrite as Rust |

**Do not** parse agent TUI output as state — still true after migration.

### 4.6 In-app browser pane (largest product gap)

Electron `<webview>` + `persist:browser` + guest hardening + downloads + find-in-page + DevTools is a mini browser.

| Option | Pros | Cons |
| --- | --- | --- |
| **A. Defer / drop in-app browser** | Unblocks migration | Feature regression |
| **B. Open system browser** | Simple | Loses pane / tabs / layout integration |
| **C. Secondary Tauri windows as “browser tabs”** | More native | Multi-window UX; harder tiling |
| **D. Embed WebView2 controls** via custom plugin / HWND | Closest to today | Heavy engineering; security surface |
| **E. Keep Electron only for browser** | — | Defeats the migration |

**Recommendation:** Phase 1–4 **ship without browser panes** (or system-browser fallback). Phase 5 design a dedicated WebView2 embedding approach if product still needs in-pane browsing. Treat browser as optional, not on the critical path.

### 4.7 Window / theme / glass

- Keep a **decorated** window so Windows owns snap / minimize / maximize / system menu.
- Map any `window:set-glass` hook to WebView2 / Win32 backdrop APIs when available; otherwise keep CSS-only Glass theme (as on Electron 29 today).
- No custom snap logic — same rule as `AGENTS.md`.

### 4.8 Clipboard, open external, menus

Tauri plugins cover clipboard, opener, dialog, notification. Port context menus carefully (browser guest menus go away if browser is deferred).

### 4.9 Auto-update and packaging

| Today | Target |
| --- | --- |
| Unsigned NSIS + electron-updater | Tauri bundler → NSIS/MSI; prefer **code signing** for updater trust |
| GitHub releases | Same distribution channel; rework update metadata to Tauri updater format |
| `asarUnpack` for node-pty | Gone — pure Rust binary + resources |

Also plan:

- App identity (`com.devterm.app` → Tauri identifier)
- Icons already in `resources/`
- Optional later: **MSIX** for Store / cleaner updates

### 4.10 Dev tooling and quality gates

| Today | Target |
| --- | --- |
| `electron-vite` | Vite frontend + `tauri dev` / `tauri build` |
| `npm run typecheck` | Keep TS typecheck + add `cargo check` / `clippy` |
| `node scripts/smoke.cjs` | Rust integration tests + optional smoke binary |
| `electron . --self-test` | `devterm --self-test` (or equivalent) CLI flag in Rust |

---

## 5. Proposed repo layout

Incremental layout (can live beside Electron until cutover):

```
devterm/
  apps/web/                 # optional move of current src/renderer + shared types
  src-tauri/                # Rust host
    src/
      main.rs
      commands/             # IPC surface
      pty/
      ssh/
      fs/
      mcp/
      agent/
      persistence/
    Cargo.toml
    tauri.conf.json
  src/                      # existing Electron tree until removed
    main/
    preload/
    renderer/
    shared/
  scripts/
  TAURI-MIGRATION.md        # this document
```

Simpler intermediate option: add `src-tauri/` next to existing `src/` without a monorepo split until Electron is deleted.

---

## 6. Phased roadmap

### Phase 0 — Preconditions

**Rough duration:** 1–2 weeks

- Freeze / document `DevTermApi` as the migration contract
- Add **settings/connections export** that decrypts secrets into a portable import format (while Electron still runs)
- Decide browser strategy (recommend: defer)
- Spike: empty Tauri 2 + React shell opens, themed, framed window
- Spike: ConPTY hello-world + event streaming into xterm
- Spike: russh connect + shell + SFTP list on one host

**Exit criteria:** spikes green; product decisions recorded in this doc’s Key Decisions section.

### Phase 1 — Shell + local terminal (vertical slice)

**Rough duration:** 3–5 weeks

- Tauri window loads Vite UI
- Implement `window.devterm` adapter for pty + fs + settings + clipboard + dialogs
- Local terminal only, then full layout store
- Themes; hotkeys that do not need SSH
- Persist settings

**Exit criteria:** usable local terminal app; layout / groups still work.

### Phase 2 — SSH workspace parity

**Rough duration:** 6–10 weeks

- Connect / shell / disconnect / status / reconnect
- SFTP browser + file explorer + editor + watches
- Transfers + (optional) port forwards
- Known hosts TOFU
- Connections manager CRUD + DPAPI secrets
- Workspaces + snippets

**Exit criteria:** primary SSH/SFTP workflows match Electron for day-to-day use.

### Phase 3 — Agent bridge

**Rough duration:** 4–8 weeks

- MCP server in Rust
- Tool map + policy + confirm UI path
- Launch prep for each agent kind
- Bridge status events + restart
- Heartbeats / timeout behavior parity

**Exit criteria:** supported agents work against remote host through the bridge.

### Phase 4 — Polish, packaging, cutover

**Rough duration:** 2–4 weeks

- Windows installer + updater
- Import from Electron userData / export files
- Self-test / smoke suite
- Performance pass (PTY/SSH event paths)
- Rewrite docs (`AGENTS.md`, `README`, etc.) for Tauri
- Remove Electron

**Exit criteria:** Tauri is the only supported desktop host on Windows.

### Phase 5 — Optional “more native” / browser

**Duration:** TBD

- Mica / Acrylic, jump lists, toast notifications
- In-app browser embedding if still required
- MSIX / Store if desired

---

## 7. What not to do

1. **Node sidecar for ssh2/node-pty “temporarily forever”** — doubles runtime, packaging pain, and fights the native goal. Short spikes only; not the architecture.
2. **Rewrite the React UI in WinUI** — multi-year cost; kills xterm/agent UX.
3. **Change terminal mount/reparent strategy during migration** — layout rules stay; only the host changes.
4. **Second SSH connection for agent tools** — keep one client per session.
5. **Block the whole migration on browser parity** — isolate it.

---

## 8. Risk register

| Risk | Impact | Mitigation |
| --- | --- | --- |
| russh ≠ ssh2 edge cases | Broken hosts | Compatibility matrix; keep Electron release until matrix green |
| ConPTY behavior vs node-pty | Agent TUIs / PowerShell failures | Port startup-failure diagnostics; test agent CLIs early |
| High-rate terminal events | UI jank | Coalesce; profile; binary payloads only if needed |
| MCP streamable HTTP in Rust | Agent bridge flaky | Protocol tests against real agent CLIs |
| Secret migration | Lost passwords | Export path before cutover |
| Browser feature gap | User complaint | Product messaging; system browser; later phase |
| Rust skill / schedule | Slip | Pair on spikes; thin command layer, solid domain crates |
| Dual-maintain Electron + Tauri | Drag | Time-box dual support; feature freeze on Electron after Phase 2 |

---

## 9. Effort ballpark

Assumes one strong full-stack engineer (Rust + TS), no major library dead-ends:

| Phase | Rough calendar |
| --- | --- |
| 0 Spikes + decisions | 1–2 weeks |
| 1 Local terminal | 3–5 weeks |
| 2 SSH / SFTP / workspaces | 6–10 weeks |
| 3 Agent / MCP | 4–8 weeks |
| 4 Packaging / cutover | 2–4 weeks |
| 5 Optional native / browser | TBD |

**Order of magnitude: ~4–7 months** to product parity **without** in-app browser.

A second engineer parallelizing Rust SSH vs frontend adapter can compress the critical path.

---

## 10. Key decisions

Record outcomes here as they are locked.

| # | Decision | Recommendation | Status |
| --- | --- | --- | --- |
| 1 | Browser pane for Tauri v1 | Defer; optional system-browser fallback | **Open** |
| 2 | Pure Rust host vs Node sidecar | Pure Rust after Phase 0 spikes | **Open** |
| 3 | SSH library | russh (+ SFTP) as default | **Open** |
| 4 | Secret storage | DPAPI-backed blobs (closest to safeStorage) | **Open** |
| 5 | Dual-ship Electron + Tauri | Electron maintained until Phase 2 exit; freeze non-critical Electron features after Phase 1 | **Open** |
| 6 | Code signing for Windows updater | Prefer signing before public Tauri auto-update | **Open** |
| 7 | Linux / macOS | Windows-first; do not block Windows cutover | **Open** |

---

## 11. Workstream / PR plan

Each workstream should leave the app runnable (Electron **or** Tauri) until the cutover PR.

| Order | Workstream | Scope | Depends on |
| --- | --- | --- | --- |
| 1 | Scaffold | `src-tauri`, Vite shell, CI `cargo check` + `tsc` | — |
| 2 | IPC adapter | `DevTermApi` facade over Tauri invoke/listen | 1 |
| 3 | PTY crate + UI | Local shell only end-to-end | 2 |
| 4 | FS + settings + dialogs | Local files, settings.json, native dialogs | 2 |
| 5 | SSH connect + shell | Profile connect, shell channel, status | 3 (PTY patterns), 2 |
| 6 | SFTP + watches + editor | Remote files, live listings, editor limits | 5 |
| 7 | Transfers + connections + secrets | Queue, progress, DPAPI, connections CRUD | 5, 6 |
| 8 | Workspaces + snippets (+ history/search as needed) | Parity with Electron managers | 5, 7 |
| 9 | MCP + agent launch | Bridge, policy, tools, agent kinds | 3, 5 |
| 10 | Installer + updater + migration import | Packaging, updates, Electron data import | 7–9 |
| 11 | Remove Electron | Delete main/preload/electron tooling; docs rewrite | 10 |

### Phase 0 spike checklist

- [ ] Tauri 2 window + existing React build loads
- [ ] Framed window; Windows snap still works
- [ ] ConPTY: spawn PowerShell, stream to xterm, resize, kill
- [ ] russh: password or key auth to a test host
- [ ] russh: interactive shell with TCP_NODELAY
- [ ] russh: SFTP list home directory
- [ ] Document browser decision (defer / fallback / embed)
- [ ] Design portable settings/connections export format

---

## 12. Success criteria

- Binary size and idle RAM clearly better than the Electron build
- Local + remote terminals feel as responsive as today (especially SSH typing latency)
- One SSH client still backs shell, SFTP, watches, and agent tools
- Agent bridge policy modes and tool surface preserved
- Users can import settings/connections from the Electron era
- Windows snap / maximize / minimize / system menu unchanged
- TS typecheck + Rust check/clippy + smoke/self-test green in CI
- Electron tree removed after cutover; docs describe Tauri-only workflow

---

## 13. Bottom line

Tauri is a good fit for DevTerm **if** the migration is treated as a **host rewrite** (PTY, SSH, MCP, persistence) and a **thin IPC re-bind** of the existing React app — not a UI rewrite.

The two gates are:

1. **ConPTY + russh fidelity** against real shells, hosts, and agent TUIs  
2. An explicit **browser-pane strategy** so it cannot block the critical path  

---

## Related docs

- `AGENTS.md` / `Claude.md` — product shape and critical rules (must remain true after migration)
- `FEATURE-PLANS.md` — other product features (session persistence, global search); re-evaluate after host rewrite
- `OVERVIEW.md` — high-level product overview
- `src/shared/types.ts` — `DevTermApi` contract to preserve
- `electron-builder.yml` / `package.json` — current packaging baseline
