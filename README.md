# DevTerm

A cross-platform desktop **SSH/SFTP terminal** with tiling panes, a file editor, an in-app
browser, saved connections & workspaces, and a built-in multi-provider **DevTerm Agent** (plus
optional Claude / Codex / Grok / OpenCode / Kimi / pi / Antigravity CLIs) that can operate on the
connected remote host — through an MCP bridge the app hosts itself, so the remote needs nothing
installed and no internet.

- 🖥️ **Local & remote terminals** — local shell (PowerShell on Windows) and SSH with
  password / private-key auth and single-hop **ProxyJump/bastion** support.
- ▦ **Tiling layout & terminal groups** — split any pane horizontally/vertically, drag to resize,
  and organise terminals into named **groups** (drag a tab onto a group, or spin off a new one).
- 💾 **Saved connections & workspaces** — store SSH profiles (secrets encrypted via the OS
  keychain), and snapshot a group of local+remote terminals — with their working directories and
  split arrangement — into a **workspace** you can relaunch into its own group.
- 📁 **File explorer + SFTP** — a sidebar that follows your shell's working directory, plus a
  dual-pane local ↔ remote browser with upload/download (streamed, cancellable), rename, delete,
  and new-folder.
- ✏️ **File editor** — open and edit files in a built-in CodeMirror 6 editor with syntax
  highlighting for common languages.
- 🌐 **In-app browser pane** — open a tabbed browser inside a pane (handles logins, copy/paste,
  and `target=_blank` pop-outs as new tabs).
- ⌨️ **Command palette & snippets** — save command scriptlets (with `{{placeholders}}`) and fire
  them into the active terminal from a **Ctrl/Cmd+K** palette; per-terminal find and a full set of
  keyboard shortcuts (see the in-app **Shortcuts** list).
- 🎨 **Themes** — nine built-in themes (Tokyo Night, Dracula, Catppuccin Mocha, Nord, Gruvbox,
  One Dark, Solarized Dark, Ayu Mirage, and a translucent **Glass**) that restyle both the terminal
  palette and the whole app chrome; plus font, cursor, scrollback and background-image preferences.
- 🤖 **DevTerm Agent bridge** — default bundled multi-provider agent (or an external CLI you pick)
  acts on the remote host via tools (`run_command`, `read_file`, `write_file`, `list_dir`,
  `get_host_context`) routed over the **same** SSH connection, with a per-host guardrail
  (`read-only` / `confirm` / `full`) enforced at the boundary. Ask from the strip under a remote
  shell, or open the full agent docked / floating / hidden without killing the session.
- 🔒 Security-first: `contextIsolation` on, `nodeIntegration` off, `sandbox` on; MCP server bound
  to `127.0.0.1` with a random per-session bearer token; SSH host-key verification (trust-on-first-use).

---

## Getting started

### Option A — Install the Windows app (easiest)

1. Go to the [**Releases**](../../releases) page and download `DevTerm-<version>-setup.exe`.
2. Run it. It's **unsigned**, so Windows SmartScreen may warn — click **More info → Run anyway**.
3. Launch **DevTerm** from the Start menu.

### Option B — Run from source

**Prerequisites:** [Node.js](https://nodejs.org) 18+ (works on 20/22/24), Git, and Windows x64.
(macOS/Linux can run the dev build too — see the note in the setup script for native binaries.)

```sh
git clone https://github.com/AEmad99/devterm.git devterm
cd devterm

npm install --ignore-scripts   # IMPORTANT: see "Native modules" — do NOT run a plain npm install
npm run setup                  # fetches the Electron binary + the node-pty prebuilt
npm run dev                    # launch with hot-reload
```

### Build your own installer

```sh
npm run build:win              # → dist/DevTerm-<version>-setup.exe (NSIS)
```

> **Packaging note:** electron-builder downloads a `winCodeSign` archive containing macOS symlinks
> that Windows can't create without admin/Developer Mode, which aborts packaging. If you hit that,
> pre-extract it once (excluding the two `.dylib` symlinks) into
> `%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\winCodeSign-2.6.0`, and build with
> `CSC_IDENTITY_AUTO_DISCOVERY=false` (we build unsigned).

---

## Using DevTerm

- **Open a terminal:** double-click a pane's tab strip or press its **＋** and pick **Local** or
  **Remote**. On Windows, local is PowerShell, so `ls`/`cd`/`pwd`/`cat` work.
- **Connect over SSH:** in the picker choose **Remote**, fill in host/user and a password or
  private-key path. Tick *"Connect through a bastion"* for a ProxyJump hop. First connection records
  the host key (trust-on-first-use); a later mismatch is rejected with a warning. Save it in the
  **Connections** tab to reconnect in one click (secrets are encrypted with the OS keychain).
- **Split & group:** split a pane from its tab strip and drag the divider to resize. Drag a pane's
  tab onto another group's tab to move it, or onto the **＋** to spin it into a new group. Use
  **Save group** to snapshot the current group as a **Workspace** (relaunches into its own group).
- **File explorer (left sidebar):** shows the active session's current directory and **follows you
  as you `cd`** in the terminal. Toggle it with the **☰** button; drag its edge to resize. Open a
  file to edit it in the built-in editor.
- **Transfer files:** on a remote tab, switch to **Files (SFTP)** for a dual-pane local ↔ remote
  browser — select a file and **Upload → / ← Download**, or use **＋ Folder / Rename / Delete**.
  Transfers stream with a live progress bar and a cancel that truly aborts.
- **Browser pane:** open an in-app browser in any pane for docs/dashboards without leaving the app.
- **Snippets & palette:** save frequently-used commands in the **Snippets** tab, then press
  **Ctrl/Cmd+K** to search and run them into the active terminal (parameterised snippets prompt for
  their `{{placeholders}}`). Press **Ctrl/Cmd+Shift+F** to find within a terminal.
- **Themes & preferences:** open **Settings** to switch theme, set the terminal font/cursor/
  scrollback/background, and toggle copy-on-select / right-click-paste. Settings persist across
  restarts.
- **Agent:** open a remote tab, pick a guardrail policy, then launch **DevTerm Agent** (bundled,
  multi-provider) or a fallback CLI from Settings. The agent runs on the **remote** via the MCP
  bridge over the same SSH connection — ask e.g. *"what's eating disk on this box?"*. Guarded/
  destructive actions can pop an approval dialog depending on policy.

> Provider credentials stay in the agent runtime (e.g. `~/.pi/agent/auth.json` or the CLI's own
> store) — DevTerm never moves API keys over its IPC.

---

## How it works

```
DevTerm Agent / CLI (local; model credentials stay with the agent runtime)
  → in-process MCP bridge (127.0.0.1 + bearer token, inside the app)
     → the SAME ssh2 connection (shell + SFTP + agent are separate channels)
        → remote host (nothing installed, no outbound internet required)
```

One `ssh2.Client` per host; the human shell, the SFTP browser, and the agent's tools each open
their own channel on it. The MCP boundary is where per-host policy is enforced.

## Security

- Renderer is sandboxed and isolated; it talks to the main process only through a typed
  `contextBridge`. No `nodeIntegration`.
- MCP server binds to `127.0.0.1` only, with a random per-session bearer token; per-session agent config and host briefings live in a temp dir and are removed on teardown.
- Saved SSH passwords/passphrases are encrypted at rest with the OS keychain (Electron
  `safeStorage`); private-key paths are stored plaintext (the key stays on disk). Workspaces and
  snippets hold **no** secrets.
- SSH host keys are verified trust-on-first-use; a later key mismatch is rejected, not auto-accepted.
- `.env` (which may hold a GitHub token used only for releasing) is git-ignored — never commit it.

## Self-test

```sh
npm run build
npx electron . --self-test
```

Runs the real production code headlessly: local PowerShell PTY runs `cd`/`ls`/`pwd`/`echo` and emits
OSC 7 cwd; an in-process `ssh2` mock server validates connect + host-key TOFU + shell echo + OS
detection (Linux & Windows); an fs-backed SFTP server validates list/mkdir/rename/delete, a 256 KB
upload + download integrity round-trip, and a true transfer cancel; the guardrail policy is
unit-tested; and the **MCP bridge** is driven by a real MCP client (bearer auth incl. rejecting a
bad token, tool listing, `run_command`/`get_host_context`/`list_dir`/`read_file` over the shared
connection, and a read-only host blocking a destructive command).

## Native modules (why the install is two steps)

`node-pty` is a C++ addon. To avoid requiring a compiler, `package.json` aliases it to
`@homebridge/node-pty-prebuilt-multiarch@0.13.1`, whose newest prebuilt targets **electron-v121**,
so Electron is pinned to **^29**. `npm run setup` fetches Electron's binary and the matching
`node-pty` Windows prebuilt into `node_modules/node-pty/build/Release/`. `electron-builder.yml` sets
`npmRebuild: false` so the prebuilt binary is shipped as-is. Any future native dep (e.g. `keytar`)
will need the same prebuilt treatment or a real toolchain.

## License

MIT — see [LICENSE](./LICENSE).
