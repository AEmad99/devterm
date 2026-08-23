## DevTerm v1.3.18

### Changed

- **Ask bar is the remote agent launch surface.** Pick the backend and type a
  prompt under the shell. Enter/Ask starts the agent. The top bar no longer
  shows a second Open agent / Agent / Policy cluster. While the agent is
  running it only offers Hide / Float / Stop.
- **The agent CLI owns permission prompts.** The session Policy picker is
  removed. Claude, Grok, and Codex are no longer forced into bypass /
  always-approve. Settings → Agent guardrails still apply allow/deny/ask rules
  at the MCP boundary.
- **First prompt starts work.** For DevTerm Agent / Pi, the first Ask is passed
  as the CLI message so the process does not open on an empty editor.
  Follow-up prompts inject into the live PTY and submit with Enter.

### Fixed

- Quiet remote shell-integration inject reclaims leftover blank rows under the
  login prompt without wiping the MOTD.

### Installer

- `DevTerm-1.3.18-setup.exe` (Windows x64, NSIS, unsigned) + differential
  update metadata (`latest.yml`, `.blockmap`).
