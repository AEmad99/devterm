# DevTerm on GPUI

A Rust rewrite of [DevTerm](https://github.com/AEmad99/devterm) on [GPUI](https://github.com/zed-industries/zed), Zed’s GPU UI framework. This is the first slice: the desktop window keeps the Electron app’s shape, and a local shell is already a real PTY.

The Electron app stays the product. This repository is the migration.

## Window

The first screen is the terminal.

- Left rail, 40px: Files, Connections, Workspaces, Snippets, then Git, dictation, shortcuts, and settings
- Library column, 280px, for the rail section that is open
- Group bar (`Group 1`, new group, Save)
- Getting-started row: local terminal, SSH connection, DevTerm Agent
- Pane tab strip over the terminal, with split, new terminal, and the agent mark
- Docked agent column
- Git column
- Status bar: `Local · Linux`, activity, transfers, DevTerm

Colors are Tokyo Night, the same boot palette as the Electron app (`#16161e`, `#1a1b26`, `#7aa2f7`).

## What works

- Local shell via `portable-pty` (ConPTY on Windows, POSIX pty elsewhere)
- Typing into that shell, including a small VT grid (cursor, erase, color sequences ignored)
- Files list for the working directory
- Concrete `Host` names from `~/.ssh/config`
- Snippets that write into the active shell
- `git status` for the working directory
- Settings, shortcuts, and command palette
- Shortcuts that match the Electron app: Ctrl+K, Ctrl+Shift+T, Ctrl+Shift+N, Ctrl+Shift+W, Ctrl+Shift+E, Ctrl+Alt+G, Ctrl+,, Ctrl+/

## What is still the Electron app

SSH sessions (`russh`), the full terminal parser (`alacritty_terminal`), the Node DevTerm Agent and the nine external CLIs, the in-app browser, SFTP transfers, and the workspace file. Those columns and buttons are in place so the window matches; they do not pretend to complete the session.

## Run

```bash
cargo run
```

GPUI 0.2.2 needs Rust 1.85 or newer (this repo pins 1.99) and a Vulkan driver. On Linux without a GPU, lavapipe works:

```bash
VK_ICD_FILENAMES=/usr/share/vulkan/icd.d/lvp_icd.json cargo run
```

`xattr` 0.2.3, pulled in by GPUI, still names `libc::ENOATTR`. Newer `libc` removed that constant. `vendor/xattr` is the same 0.2.3 crate with Linux `ENOATTR` mapped to `ENODATA`.

## Tests

```bash
cargo test
```

Covers the VT grid and SSH config host parsing.
