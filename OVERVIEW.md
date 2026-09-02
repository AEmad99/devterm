# DevTerm — Overview

**DevTerm** is a cross-platform desktop application that combines an SSH/SFTP terminal,
a tiling pane workspace, a file editor, an in-app browser, and a built-in multi-provider
**DevTerm Agent** (plus Claude / Codex / Grok / OpenCode / Kimi / pi / Antigravity CLIs)
that can operate on connected remote hosts *or* in a local folder. Remote work goes
through an MCP bridge the app hosts locally, so the remote host needs nothing installed
and no outbound internet connection.

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
- **Detached remote sessions** — tmux picker on connect (live preview, attach, kill).
- **Session restore** — last local + saved-SSH groups come back on boot (optional).
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
- Markdown **Edit / Side / Preview** (Ctrl/Cmd+Alt+M cycles).

### 🌐 In-app browser pane
- A tabbed browser that can live in any pane — handy for dashboards, docs, and web tools.
- Handles logins, copy/paste, and `target=_blank` pop-outs as new tabs.
- Agents drive tabs through first-class `browser_*` MCP tools (visible cursor on click/type).

### ⌨️ Command palette & snippets
- **Ctrl/Cmd+K** opens a searchable palette of saved command snippets.
- Snippets support `{{placeholders}}` — parameterised snippets prompt for their values.
- **Ctrl/Cmd+Shift+F** for in-terminal find; **Ctrl/Cmd+Alt+F** for global search.

### 🎨 Themes & preferences
- Nine built-in themes: **Tokyo Night, Dracula, Catppuccin Mocha, Nord, Gruvbox,
  One Dark, Solarized Dark, Ayu Mirage,** and a translucent **Glass**.
- Each theme restyles both the terminal palette and the whole app chrome.
- Settings cover terminal font, cursor style, scrollback, background image, and
  copy-on-select / right-click-paste toggles. Settings persist across restarts.

### 🤖 DevTerm Agent (MCP bridge)
- Default bundled multi-provider runtime, plus external CLIs: Claude, Codex, Grok,
  OpenCode, Kimi, pi, Antigravity. Open Agent from the pane tab strip; dock, float,
  or hide without killing the process.
- **Remote:** host tools (`run_command`, `read_file`, `write_file`, `list_dir`,
  `get_host_context`) over a per-session MCP server on the **same** SSH connection.
- **Local:** CLI builtin fs/shell in the operator folder; MCP is `browser_*` plus
  local handoff (`agent_list` / `agent_delegate` / `agent_message`).
- Permission prompts belong to the agent CLI. Settings → Agent guardrails remain
  an allow/deny/ask pre-check at the MCP boundary.

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
DevTerm Agent / CLI (local; model credentials stay with the agent runtime)
        │
        ▼
in-process MCP bridge  (127.0.0.1 + bearer token, inside the app)
        │
        ├─ remote → ssh2 connection (one per host; shell, SFTP, agent channels)
        │            → remote host (nothing installed, no outbound internet)
        └─ local  → CLI builtin tools in the operator folder
                     MCP: browser_* + agent_delegate / agent_list / agent_message
```

The MCP boundary is the chokepoint for remote host work and in-app browser control.
Approval rules pre-check there; the agent CLI owns interactive permission prompts.

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