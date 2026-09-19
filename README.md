# DevTerm

<p align="center">
  <img src="resources/icon.png" width="96" alt="DevTerm icon">
</p>

<p align="center">
  <strong>A desktop SSH/SFTP terminal with tiling panes, files, git, and a built-in coding agent.</strong><br>
  Remote hosts need nothing installed and no outbound internet.
</p>

<p align="center">
  <a href="https://github.com/AEmad99/devterm/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/AEmad99/devterm?label=release"></a>
  <a href="./LICENSE"><img alt="MIT License" src="https://img.shields.io/github/license/AEmad99/devterm"></a>
  <img alt="Windows" src="https://img.shields.io/badge/platform-Windows-0a7cff">
</p>

DevTerm is a normal framed Windows app. You open it and you are in a terminal — local PowerShell, SSH, or both — with splits, groups, a file sidebar, an editor, an in-app browser, and an agent that can work on the connected host through the same SSH session.

**Current release: [v1.3.30](https://github.com/AEmad99/devterm/releases/tag/v1.3.30)**

![DevTerm terminal workspace](resources/screens/terminal.png)

---

## Why it exists

Most agent terminals either install a runtime on the server or send host work out through the model vendor. DevTerm keeps the agent on your machine and reaches the remote through an in-process MCP bridge on the **same** ssh2 connection as the shell and SFTP. The server stays a normal SSH host.

---

## What you get

- **Local and SSH terminals** — PowerShell (or cmd / a custom shell) locally; password or key SSH with a single bastion hop. POSIX remotes with a working tmux get a live session picker. Optional last-session restore on boot.
- **Tiling panes and groups** — split any pane, drag to resize, and keep independent named groups. Launch a 4×4 remote grid when you need a wall of shells.
- **Saved connections and workspaces** — OS-keychain secrets, `~/.ssh/config` import, and workspace snapshots of a group's hosts, folders, and split tree.
- **Files, SFTP, and an editor** — a sidebar that follows `cd`, a dual-pane transfer browser with a persistent queue, and CodeMirror 6 (Markdown Edit / Side / Preview).
- **Git panel** — status, stage, commit, push/pull, branches, stash, tags, remotes, and a commit graph. Remote repos reuse the session's SSH exec channel.
- **In-app browser** — tabbed http(s) panes for docs and dashboards. Agents can drive them through `browser_*` tools.
- **Command palette, snippets, search** — Ctrl/Cmd+K for actions, snippets (`{{placeholders}}`), connections, workspaces, and history. Per-pane find and global search across terminals.
- **DevTerm Agent** — bundled multi-provider agent, plus Claude, Codex, Grok, OpenCode, Kimi, pi, Antigravity, and Muse Code. Dock, float, or hide the UI without killing the process. Remote host tools ride MCP; local agents work in the folder that terminal is in.
- **Port forwards, dictation, themes** — local `-L` and SOCKS `-D`, offline Whisper push-to-talk, and nine themes (including Glass) that restyle chrome and the terminal together.

![Git panel](resources/screens/git-panel.png)

![Command palette](resources/screens/command-palette.png)

![Create a terminal grid](resources/screens/grid-modal.png)

---

## Install (Windows)

1. Download `DevTerm-<version>-setup.exe` from [Releases](https://github.com/AEmad99/devterm/releases/latest).
2. Run it. The build is **unsigned**, so SmartScreen may warn — **More info → Run anyway**.
3. Launch **DevTerm** from the Start menu.

---

## Run from source

**Need:** Node.js 18+ (20/22/24 are fine), Git, Windows x64.

```sh
git clone https://github.com/AEmad99/devterm.git
cd devterm
npm install --ignore-scripts   # do not run a plain npm install
npm run setup                  # Electron binary + node-pty prebuilt
npm run dev
```

```sh
npm run build:win              # → dist/DevTerm-<version>-setup.exe
```

If packaging dies on `winCodeSign` macOS symlinks, extract that cache once (skip the two `.dylib` links) into `%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\winCodeSign-2.6.0` and build with `CSC_IDENTITY_AUTO_DISCOVERY=false`.

**Native modules:** `node-pty` is aliased to a prebuilt (`electron-v121`), which is why Electron stays on **29**. Never `npm rebuild` it. `npm run setup` drops the Windows ConPTY addons into `node_modules/node-pty/build/Release/`.

---

## Agent model

```
DevTerm Agent / CLI  (credentials stay in the agent runtime)
  → MCP bridge on 127.0.0.1 + a random bearer token
     → remote: same ssh2 client (shell, SFTP, and agent are separate channels)
        → host needs nothing installed
     → local: CLI fs/shell in the operator folder; MCP is browser + tab handoff
```

Open Agent from the pane tab strip. Hide and Float do not stop it; Stop / close tab / quit do. Approval rules under **Settings → Agent guardrails** are an MCP pre-check. The CLI still owns its own permission prompts. Provider keys never cross DevTerm IPC.

---

## Security

- Renderer: `contextIsolation` on, `nodeIntegration` off, `sandbox` on; typed `contextBridge` only.
- MCP listens on loopback with a per-session bearer token. Temp agent config is deleted on teardown.
- SSH passwords/passphrases use the OS keychain (`safeStorage`). Host keys are TOFU; a later mismatch is rejected.
- Workspaces and snippets store no secrets.

---

## Stack

| Layer | Choice |
| --- | --- |
| App | Electron 29, React 19, TypeScript, Zustand |
| Terminal | xterm.js (canvas renderer), node-pty, ssh2 |
| Editor | CodeMirror 6 |
| Agent | bundled pi-coding-agent + MCP SDK; 8 optional CLIs |
| Packaged as | unsigned Windows NSIS (`com.devterm.app`) |

---

## Using it

- **New terminal:** double-click a pane tab strip, or press **＋**, and pick Local or Remote.
- **SSH:** host/user plus password or key. Tick *Connect through a bastion* for one ProxyJump hop. Save it under **Connections**.
- **Split / group:** split from the tab strip; drag a tab onto a group, or onto **＋** for a new group. **Save group** writes a workspace.
- **Files:** the left sidebar follows the active shell cwd. On a remote tab, **Files (SFTP)** is the dual-pane transfer UI.
- **Agent:** sparkle opens it; the letter mark picks the backend.

---

## Verify a checkout

```sh
npm run typecheck
npm run test
node scripts/smoke.cjs
```

Headless production self-test (needs a build, ~90s):

```sh
npm run build
npx electron . --self-test
```

Release history is in [CHANGELOG.md](./CHANGELOG.md). Agent-facing architecture notes live in [AGENTS.md](./AGENTS.md).

## License

MIT — [LICENSE](./LICENSE).
