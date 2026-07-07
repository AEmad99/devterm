# DevTerm — Overview

**DevTerm** is a cross-platform desktop application that combines an SSH/SFTP terminal,
a tiling pane workspace, a file editor, and an in-app browser with a built-in **Claude
coding agent** that can operate on connected remote hosts. The agent talks to those
remote machines through an MCP bridge the app hosts locally, so the remote host needs
nothing installed and no outbound internet connection.

It is built on Electron + React + TypeScript, with `xterm.js` for the terminal,
`node-pty` for local shells, `ssh2` for SSH/SFTP, CodeMirror 6 for editing, and the
Model Context Protocol SDK for the agent bridge.

---

## Core capabilities

### 🖥️ Terminals (local & remote)
- **Local shell** — runs the platform shell (PowerShell on Windows) via `node-pty`.
- **SSH remote shell** — connects with password or private-key authentication.
- **ProxyJump / bastion host** — single-hop SSH through a bastion.
- **SSH host-key verification** — trust-on-first-use, with later mismatches rejected.
- One `ssh2.Client` per host; shell, SFTP, and agent channels are multiplexed over it.

### ▦ Tiling layout & terminal groups
- Split any pane **horizontally or vertically**; drag the divider to resize.
- Organise terminals into **named groups** — drag a tab onto a group, or spin one off.
- A **workspace** snapshots a group of terminals (local + remote, working directories,
  split arrangement) and relaunches it into its own group.

### 📁 File explorer + SFTP
- A left sidebar file explorer that **follows the shell's working directory** as you `cd`.
- A **dual-pane local ↔ remote browser** with upload/download, rename, delete, new-folder.
- Transfers are **streamed with live progress** and a **true cancel** that aborts mid-stream.

### ✏️ File editor
- Open files from the sidebar in a built-in **CodeMirror 6** editor.
- Syntax highlighting for common languages (JS/TS, Python, Rust, HTML/CSS, JSON,
  Markdown, YAML, XML).

### 🌐 In-app browser pane
- A tabbed browser that can live in any pane — handy for dashboards, docs, and web tools.
- Handles logins, copy/paste, and `target=_blank` pop-outs as new tabs.

### ⌨️ Command palette & snippets
- **Ctrl/Cmd+K** opens a searchable palette of saved command snippets.
- Snippets support `{{placeholders}}` — parameterised snippets prompt for their values.
- **Ctrl/Cmd+Shift+F** for in-terminal find; a full keyboard-shortcut list is in-app.

### 🎨 Themes & preferences
- Nine built-in themes: **Tokyo Night, Dracula, Catppuccin Mocha, Nord, Gruvbox,
  One Dark, Solarized Dark, Ayu Mirage,** and a translucent **Glass**.
- Each theme restyles both the terminal palette and the whole app chrome.
- Settings cover terminal font, cursor style, scrollback, background image, and
  copy-on-select / right-click-paste toggles. Settings persist across restarts.

### 🤖 Claude coding agent (MCP bridge)
- Runs the real interactive `claude` CLI locally under your subscription (never the SDK
  or API-key path — it's human-in-the-loop).
- Exposes tools (`run_command`, `read_file`, `write_file`, `list_dir`,
  `get_host_context`) over a per-session MCP server that the app hosts itself.
- Each tool call is routed over the **same** SSH connection as the human shell.
- A per-host **guardrail policy** is enforced at the MCP boundary:
  - `read-only` — destructive commands are blocked.
  - `confirm` — destructive actions pop an approval dialog.
  - `full` — no prompt.
- Optional **air-gapped** mode for fully offline remote operation.

### 🔒 Security
- `contextIsolation` on, `nodeIntegration` off, `sandbox` on; the renderer talks to the
  main process only through a typed `contextBridge`.
- MCP server binds to `127.0.0.1` only with a **random per-session bearer token**.
- SSH passwords/passphrases are encrypted at rest via the OS keychain
  (Electron `safeStorage`); private-key paths are stored as paths only.
- SSH host keys are verified trust-on-first-use.
- Workspaces and snippets contain **no secrets**.

---

## How the agent reaches the remote host

```
claude CLI (local, your subscription, internet for the model)
        │
        ▼
in-process MCP bridge  (127.0.0.1 + bearer token, inside the app)
        │
        ▼
ssh2 connection  (one per host; shell, SFTP, and agent are separate channels)
        │
        ▼
remote host  (nothing installed, no outbound internet required)
```

The MCP boundary is the single chokepoint where the per-host guardrail policy is
enforced — nothing reaches the remote host without going through it.

---

## Quick start

**Install (Windows, easiest):**
1. Download `DevTerm-<version>-setup.exe` from Releases.
2. Run it (unsigned → SmartScreen → *More info → Run anyway*).
3. Launch DevTerm from the Start menu.

**Run from source:**

```sh
git clone https://github.com/AEmad99/devterm.git devterm
cd devterm
npm install --ignore-scripts   # see Native modules — do NOT run a plain install
npm run setup                  # fetches Electron + node-pty prebuilt
npm run dev                    # launch with hot-reload
```

**Build an installer:**

```sh
npm run build:win              # → dist/DevTerm-<version>-setup.exe (NSIS)
```

---

## Self-test

```sh
npm run build
npx electron . --self-test
```

The self-test exercises the real production code headlessly: local PowerShell PTY runs
`cd`/`ls`/`pwd`/`echo` and emits OSC 7 cwd; an in-process `ssh2` mock server validates
connect + host-key TOFU + shell echo + OS detection (Linux & Windows); an fs-backed SFTP
server validates list/mkdir/rename/delete, a 256 KB upload + download integrity
round-trip, and a true transfer cancel; the guardrail policy is unit-tested; and the
**MCP bridge** is driven by a real MCP client — bearer auth (incl. rejecting a bad
token), tool listing, and `run_command` / `get_host_context` / `list_dir` / `read_file`
over the shared connection, plus a read-only host blocking a destructive command.

---

## Stack

| Concern        | Choice                                                |
| -------------- | ----------------------------------------------------- |
| Shell          | Electron + React + TypeScript                         |
| Terminal       | `xterm.js` (`@xterm/xterm` 5.5)                       |
| Local PTY      | `node-pty` (prebuilt multiarch)                       |
| SSH / SFTP     | `ssh2`                                                |
| Editor         | CodeMirror 6 (language packs for JS/TS, Python, etc.) |
| State          | Zustand                                               |
| Build / bundle | `electron-vite`, `electron-builder` (NSIS, unsigned)  |
| Agent bridge   | `@modelcontextprotocol/sdk`                           |

---

## License

MIT — see [LICENSE](./LICENSE).