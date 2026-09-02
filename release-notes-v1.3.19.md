## DevTerm v1.3.19

Combines everything from v1.3.18 with native local agents, in-app browser
control, local agent handoff, and the tab-strip Open Agent launcher.

### Added

- **Native local agent.** Open Agent on a local pane uses the CLI's own
  Read/Write/Bash tools in the operator's folder. MCP host tools stay
  remote-only; in-app `browser_*` tools remain on the MCP bridge.
- **In-app `browser_*` tools** (11): list / open / navigate / snapshot /
  click / type / press_key / screenshot / attach / detach / close.
  Agent-owned tabs are freely drivable; operator tabs need a one-time
  attach confirm. `browser_open` splits a pane beside the agent.
- **Visible agent cursor** in the in-app browser so clicks and typing
  can be followed live.
- **Local agent handoff.** Local-only MCP tools `agent_list`,
  `agent_delegate`, and `agent_message` open a visible sibling tab (or
  split) for another agent. Never registered on remote bridges.
- **Markdown preview hotkey.** Ctrl/Cmd+Alt+M cycles Edit / Side /
  Preview for Markdown files.

### Changed

- **Open Agent lives on the pane tab strip.** Kind picker (official
  brand icons) + sparkle launch replace the 1.3.18 ask bar. Hide /
  Float / Stop while running. Process lifetime stays independent of
  docked / floating / hidden.
- **The agent CLI still owns permission prompts** (carried forward from
  1.3.18). No session Policy picker. Settings → Agent guardrails remain
  an MCP pre-check. First-launch prompts for DevTerm Agent / Pi (and
  delegated handoff) still go on the CLI so work starts immediately.
- **In-app browser is first-class** in agent briefings.
- **Grok native-local isolation.** MCP config lives under `GROK_HOME`.

### Fixed

- Local `browser_open` no longer times out on an off-screen webview.
- MCP session file for local agents stays in the overlay, not the
  project tree.
- Bundled Node runtime + offline model catalog for the built-in agent.
- Quiet remote shell-integration inject from 1.3.18 is unchanged.

### Installer

- `DevTerm-1.3.19-setup.exe` (Windows x64, NSIS, unsigned) + differential
  update metadata (`latest.yml`, `.blockmap`).
