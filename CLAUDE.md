# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

DevTerm is an Electron desktop terminal: SSH/SFTP client, tiling/split panes, saved connections, terminal workspaces, a file editor, an in-app browser pane, saved command snippets, a command palette, a themable chrome, and an embedded Claude agent bridge. TypeScript (strict) + React 18 + Zustand, bundled with electron-vite. Use the map below to jump straight to the relevant code instead of scanning the tree.

The top bar has four top-level views — **Terminals**, **Connections** (saved-SSH manager tab), **Workspaces** (saved terminal-preset tab), and **Snippets** (saved-command manager tab). New terminals are opened from a picker (double-click a pane's tab strip or press its ＋) that asks local-vs-remote — there are no longer fixed `+ Local` / `+ SSH` buttons. A pane can also host an **in-app browser** instead of a shell (`kind: 'browser'`). A **command palette** (Ctrl/Cmd+K) runs snippets into the active terminal, and global keyboard shortcuts live in `lib/hotkeys.ts` (the **Shortcuts** modal lists them). The window is **frameless + transparent** with custom min/max/close controls.

## Commands

- `npm run setup` — one-time: fetches the Electron binary + the **node-pty prebuilt** (no local C++ build). Run before first `dev`.
- `npm run dev` — electron-vite dev with hot reload.
- `npm run typecheck` — `tsc --noEmit` over `tsconfig.node.json` (main+preload) and `tsconfig.web.json` (renderer). This is the primary correctness gate, and it's what the Stop hook runs each turn.
- `npm run lint` — ESLint (flat config `eslint.config.mjs`: typescript-eslint + react-hooks on `.tsx`). `npm run format` / `npm run format:check` — Prettier (no semicolons, single quotes, no trailing commas; see `.prettierrc.json`). Lint/format are advisory; Prettier was added after most code was written, so legacy files may still report style diffs.
- `npm run build` — bundle to `out/`.
- `npm run build:win` / `npm run build:linux` — electron-vite build + electron-builder (Windows NSIS x64 / Linux AppImage).
- `node scripts/smoke.cjs` — smoke test. `electron . --self-test` runs the headless self-test (90s timeout).

## Architecture map

Process split: **main** (`src/main`, Node) ↔ **preload** (`src/preload/index.ts`, the only renderer↔main bridge) ↔ **renderer** (`src/renderer`, React). IPC contract types live in `src/shared/types.ts` (alias `@shared/*`) and are the source of truth shared by both sides.

| Area | Code |
|------|------|
| App entry / window / IPC registration | `src/main/index.ts` |
| IPC handlers | `src/main/ipc/` (`pty`, `ssh`, `files`, `claude`, `connections`, `workspaces`, `context`, `snippets`, `window`) |
| Snippets store (CRUD, `userData/snippets.json`) | `src/main/ipc/snippets.ts`, renderer `lib/snippets.ts`, `components/SnippetsManager.tsx`, `SnippetForm.tsx` |
| Command palette / per-terminal find / shortcuts | `components/CommandPalette.tsx`, `SearchBar.tsx`, `ShortcutsModal.tsx`; `lib/hotkeys.ts`, `lib/input.ts`, `lib/terms.ts` |
| In-app browser pane | `components/BrowserPane.tsx`, `lib/browserTabs.ts` (a `<webview>` host; `browser:open-tab` IPC) |
| Theme engine + icons | `src/renderer/lib/themes.ts`, `components/Icons.tsx` |
| Claude bridge (spawn CLI) | `src/main/claude/launch.ts`, `claude/context.ts` |
| MCP server + agent tools + guardrails | `src/main/mcp/server.ts`, `tools.ts`, `policy.ts` |
| SSH/SFTP | `src/main/ssh/` (`manager`, `connection`, `sftp`, `knownHosts`, `osDetect`) |
| Local PTY | `src/main/pty/manager.ts` |
| Local FS / transfers | `src/main/fs/`, `src/main/transfer.ts` |
| Tiling layout + split panes | `src/renderer/store/layout.ts`, `components/TerminalLayout.tsx`, `Splitter.tsx` |
| Terminal view (xterm.js) | `src/renderer/components/TerminalView.tsx`, `lib/renderer.ts`, `lib/fit.ts` |
| File editor (CodeMirror 6) | `src/renderer/components/EditorView.tsx`, `lib/cm-languages.ts` |
| SFTP / file browser | `src/renderer/components/SftpBrowser.tsx`, `FilePane.tsx`, `FileExplorer.tsx` |
| Top-level views + pickers | `src/renderer/App.tsx` (view nav), `components/NewTerminalModal.tsx`, `ConnectionsManager.tsx`, `WorkspacesManager.tsx`, `ConnectionForm.tsx` |
| Renderer state | `src/renderer/store/` (`sessions`, `editors`, `layout` — all in-memory, not persisted) |

## Critical gotchas

- **node-pty is a prebuilt native module** (`@homebridge/node-pty-prebuilt-multiarch`, pinned to Electron 29's ABI). Never `npm rebuild` it locally — this box has no C++/Python toolchain (see memory). It is `asarUnpack`'d in `electron-builder.yml`; if you touch packaging, keep it unpacked or the `.node` file won't load at runtime.
- **Electron security is locked down**: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`. The renderer cannot `require` Node or touch the shell — everything crosses the typed `contextBridge` API in `src/preload/index.ts`. New renderer↔main capability = add to `src/shared/types.ts` → handler in `src/main/ipc/` → expose in preload.
- **The Claude bridge spawns the real interactive `claude` CLI** in a PTY (not the API/SDK). It writes a per-session `--mcp-config` + temp `CLAUDE.md`, and the CLI connects back to an **in-process MCP server** at `127.0.0.1:<random-port>` gated by a per-session bearer token. Output is a raw terminal — do not try to parse or automate it. Requires `claude` on PATH and an active login.
- **MCP agent tools are guarded in `src/main/mcp/policy.ts`** by per-host mode: `read_only` (blocks mutating cmds), `confirm` (prompts on destructive cmds), `full` (lab only). New tools in `tools.ts` must respect the policy boundary; destructive ops route through the renderer approval dialog (`ConfirmActionModal.tsx`, 2-min timeout).
- **SSH host keys are trust-on-first-use** (`ssh/connection.ts` + `knownHosts.ts`), stored in `userData` (not `~/.ssh`). A key mismatch is rejected, not auto-accepted.
- **Working directory tracking uses OSC 7**: local PowerShell prompt injection and a remote shell hook (`__dt7`) feed cwd into `session.cwd`. Both the left `FileExplorer` and the SFTP browser's remote `FilePane` follow it (the SFTP pane via the `followPath` prop, wired in `SftpBrowser.tsx`). `FilePane`/`FileExplorer` also have an editable path box — type a path + Enter to jump. Preserve the OSC 7 emit on **every** prompt when editing shell-setup code, or follow breaks on `cd`.
- **Remote SSH uses TCP_NODELAY**: `ssh/connection.ts` dials its own `net.Socket` with `setNoDelay(true)` and hands it to ssh2 via the `sock` option (ssh2 won't set it otherwise). Without this, interactive SSH feels laggy from Nagle buffering. Keep dialing the socket ourselves if you touch the connect path.
- **The terminals view is always mounted** (`App.tsx`): switching to Connections/Workspaces toggles `display:none`, it does **not** unmount `TerminalLayout`. Unmounting would dispose every `TerminalView`, killing the local PTYs and dropping the SSH shells. Never gate the terminals layout behind a `view === 'terminals' && …` conditional render — hide it, don't remove it.
- **Terminal groups (`store/layout.ts`)**: the layout holds `groups: Group[]`, each with its **own** split tree (`root`/`activeLeaf`); `DEFAULT_GROUP` ('default') holds loose terminals; users also create groups **on demand** (the group bar's "＋", `createGroup`) and every launched workspace is its own group, all shown in the group bar above the panes (`App.tsx`). A `Session.groupId` declares membership (new terminals default to the active group via `useLayout.getState().activeGroupId`). Terminals are re-grouped live by **dragging a pane tab onto a group tab** (→ `sessions.setGroup`, `moveToGroup` in `App.tsx`) or onto the "＋" zone to spin off a new group (`spinOffGroup`). A group is always created **together with a terminal** — the "＋" button does `createGroup()` + `addLocal({groupId})`, and `spinOffGroup` moves the dragged terminal in — so a non-default group is never left transiently empty, and `sync` therefore prunes **any** empty non-default group (closing a group's last terminal removes its tab). `DEFAULT_GROUP` is the exception: it always persists, and when it's the active tab with no terminals `App` overlays a "No ungrouped terminals" prompt whose button opens a terminal directly in the active group. `TerminalLayout` always renders **all** sessions in its term-layer (so other groups' terminals stay mounted/alive) but draws panes from the active group's tree only — non-active sessions get no leaf and fall to `display:none`. Layout actions (`drop`/`resize`/`mergeLeaf`/…) operate on the active group via `patchActive`. `sync` reconciles every group and auto-focuses a populated group if the active one empties; empty non-default groups are pruned. Launching a workspace = `ensureGroup` → add sessions with that `groupId` → `restoreGroup(id, name, snap)`; it never touches other groups (so it sits beside, not over, existing terminals).

- **Theming is a single engine (`renderer/lib/themes.ts`)**: one `Theme` drives **both** the xterm ANSI palette (`xtermTheme()`) and the app chrome. `applyTheme()` writes core colour tokens (`--bg`, `--panel`, `--accent`, `--fg`, …) onto the document root; `styles.css` derives the rest (hovers, faded accents) with `color-mix`, so most CSS is theme-agnostic — **use the CSS vars, don't hardcode hex**. Adding a theme = append to `THEMES`. The active `themeId` lives in the settings store and is bootstrapped in `main.tsx` before first paint. `TerminalView` re-applies the palette live on `themeId`/`terminalBg` change without recreating the terminal.
- **The BrowserWindow is frameless + `transparent: true`** (`main/index.ts`). A normal window frame forces an opaque background on Windows, so the **Glass** theme can only let the desktop show through with `frame: false`. Because there's no OS titlebar, the app's `.titlebar` is the drag region (`-webkit-app-region: drag`, with `no-drag` on its interactive children) and `App.tsx`'s `WindowControls` drives min/maximize/close via the `window:*` IPC (`ipc/window.ts`); `main/index.ts` forwards maximize/unmaximize back so the button stays in sync. Non-glass themes paint a fully **opaque** app surface via the `--bg` token, so the window looks solid as usual — never remove that opaque fill or every theme goes see-through. Real OS Acrylic/Mica needs `setBackgroundMaterial` (Electron ≥30); we're pinned to 29, so the material call is feature-detected (no-op today, auto-upgrades later), driven by the `window:set-glass` IPC from `applyTheme()`.

## Persistence

Saved connections: `userData/connections.json` (`{version:1, connections:[...]}`), written atomically (`.tmp` + rename). `password`/`passphrase` fields are encrypted with Electron `safeStorage` (`v1:` prefix; `raw:` fallback when no OS keychain). Private-key paths are stored plaintext (the key stays on disk).

Workspaces: `userData/workspaces.json` (`{version:1, workspaces:[...]}`), same atomic write, **no encryption** — a `Workspace` is `{id, name, items: WorkspaceItem[], layout?}`. A `WorkspaceItem` is `{id, kind: 'local'|'remote', connectionId?, cwd?, title?}`; the saved `layout` leaves reference these item ids (never session ids or secrets). It captures **both local and remote** terminals plus each one's working directory and the split arrangement. Capture is initiated from the **Terminals view** — the group bar's "Save group" button (`App.tsx`) opens `SaveWorkspaceModal.tsx` to name it; the actual snapshot is built by `captureWorkspace()` in `renderer/lib/workspace.ts` from the **active group** (one item per open session; only ad-hoc SSH with no `connectionId` is skipped). Since groups are now curated on demand (drag tabs in/out), saving a group persists exactly that hand-picked set — not "everything open". The **Workspaces tab** (`WorkspacesManager.tsx`) is now a read-only list (name + brief description) that only launches/deletes. Launch replays a workspace into its **own new group** (`toLiveSnapshot` in the same lib): `ensureGroup` → locals reopen via `addLocal({cwd, groupId})` (→ pty `cwd` option), remotes via `connectSsh(profile, { connectionId, startCwd, groupId })` (TerminalView `cd`s in after the shell opens), then `restoreGroup(id, name, snap)` rebuilds the splits and focuses the group (or `setActiveGroup` if the workspace has no saved layout). Legacy pre-1.0.1 remote-only files (`{connectionIds[]}`) are migrated to items on load (`migrate()` in `ipc/workspaces.ts`). Linking a live remote session back to its saved connection relies on `session.connectionId`.

App settings: `userData/settings.json` (no secrets) — `{themeId, terminalBg, prefs}` where `prefs` is font/cursor/scrollback/copy-paste/bell preferences (`store/settings.ts`). Bootstrapped in `main.tsx` before first paint so the theme applies without a flash.

Snippets: `userData/snippets.json` (`{version:1, snippets:[...]}`), atomic write, **no encryption** (`ipc/snippets.ts`) — saved command scriptlets with optional `{{placeholders}}`; parameterised ones run through the command palette, plain ones straight into the active terminal. Don't store secrets in a snippet.

Layout/editors/sessions are **not** persisted — in-memory Zustand only.

## Repo etiquette

Commit directly to `main` (no PR flow). Run `npm run typecheck` (the required gate) and ideally `npm run lint` before committing. Format new/edited files with `npm run format`.
