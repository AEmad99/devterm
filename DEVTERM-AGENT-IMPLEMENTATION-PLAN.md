# DevTerm — Agent Implementation Plan

**Repo:** `AEmad99/devterm`  
**Audience:** a coding agent working in this repository  
**Companion docs (read first, code wins on conflict):** `AGENTS.md`, `CHANGELOG.md`, `README.md`, `.claude/skills/*`  
**Current baseline this plan was written against:** `package.json` version `1.3.30` (September 2026)

This file is the execution plan. Do not treat it as marketing. Implement in the order given. Do not skip invariants. Do not add enterprise features.

---

## 0. How to use this file

1. Read `AGENTS.md` end to end before writing code.
2. Pick **one workstream item** (a single heading under the active phase). Do not start the next item until the current one has tests, `npm run typecheck`, and a changelog note.
3. Follow the IPC rule for every new renderer↔main capability: edit **all three** of `src/shared/types.ts`, `src/main/ipc/*` (+ register in `src/main/index.ts`), and `src/preload/index.ts` in the same change.
4. Run the gates in §16 before considering an item done.
5. Update this file’s **Progress log** and `AGENTS.md` Known limits when a limit is lifted.
6. Commit directly to `main` only if the operator asked. Otherwise use a branch named `plan/v1.4-<slug>` or `plan/v1.5-<slug>`.

If this file and `AGENTS.md` disagree about current architecture, **`AGENTS.md` and the code win**. If they disagree about product direction, **this file wins** unless the operator says otherwise.

---

## 1. Vision (do not dilute)

DevTerm is the daily-driver desktop terminal for developers who work on **local machines and remote SSH hosts** with **AI coding agents**.

The sentence that must remain true:

> DevTerm is the terminal where agents work on machines that never hear about the agents.

### What that means in practice

- The agent process runs on the operator laptop.
- Remote host work goes through DevTerm’s in-process MCP bridge on the **same** `ssh2` connection as the visible shell and SFTP.
- The remote needs nothing installed and no outbound internet.
- Local agents work in the folder that terminal is in; MCP on local is browser + sibling-agent handoff.
- Process lifetime is independent of UI placement (dock / float / hide).
- This is a personal/small-team tool, not an enterprise console.

### Non-goals (refuse these if asked mid-implementation)

- SSO / SAML / OIDC / SCIM / directory sync
- Cloud settings sync, team vaults, shared workspaces-as-a-service
- Mobile client
- RDP / VNC (RDP was removed on purpose)
- Kubernetes / cloud-account plugin marketplace
- Becoming an IDE (LSP, debugger, project-wide refactor UI)
- WebGL terminal renderer (until a context-budget strategy exists)
- Programmable public socket/CLI API (until v1.4 hibernate + restore ship)
- Plugin store or executable third-party extensions
- macOS signed notarized release pipeline (not a product focus)

---

## 2. Product invariants (never break)

These are load-bearing. A “cleaner” design that violates one of them is a bug.

1. **Never unmount `TerminalLayout`.** Never reparent xterm DOM slots. Inactive groups stay mounted and are hidden with `.term-hidden` (visibility + off-screen translate). Never `display: none` on a live terminal slot.
2. **Focus mode and zen mode only reposition/hide.** They must never scale terminal text.
3. **One primary `ssh2.Client` per normal remote session**, shared by shell, SFTP, exec, watches, port forwards, git, and agent tools. Windows OpenSSH compatibility mode is the documented exception (auxiliary clients for command/SFTP/forwards; visible shell stays on the primary).
4. **Direct SSH hops keep `setNoDelay(true)`.**
5. **Agent UI mode ≠ process lifetime.** Hide / float / dock must not call `agent.close`. Only explicit Stop, session close, or quit tears the agent down.
6. **`agent:open` is idempotent** unless `forceRestart`. Reattach must require stored `lastOpts.kind` to match, or switching kinds in the picker will silently show the old process.
7. **Credentials never cross DevTerm IPC.** Report authenticated-provider *presence* only.
8. **MCP listens on `127.0.0.1` + random port + random bearer token.** Temp agent config is deleted on teardown.
9. **Renderer is sandboxed:** `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`. Nothing reaches the renderer except through preload.
10. **Canvas xterm renderer stays.** Do not switch to WebGL.
11. **POSIX shell-integration inject:** `writeQuiet` (`stty -echo` as its own line, then payload). Never `clear`. Never type setup into an existing tmux pane. Keep deferred `${__dtA}` / `${__dtB}` PS1 references.
12. **tmux attach is a child process, never `exec`.**
13. **Windows packaged builds must ship ConPTY natives and the agent nested dependency closure.** Do not “clean up” `asarUnpack` or `afterPack` without re-verifying a packaged boot.
14. **Never `npm rebuild` node-pty. Never plain `npm install`.** First-time: `npm install --ignore-scripts` then `npm run setup`.
15. **Keep the BrowserWindow normal/framed.** No custom window controls.
16. **Use theme CSS variables.** Keep motion out of the xterm viewport and behind reduced-motion guards.

---

## 3. Architecture map (where to edit)

| Area | Path |
| --- | --- |
| App / IPC registration | `src/main/index.ts` → `registerIpc()` |
| Shared contract | `src/shared/types.ts` |
| Preload | `src/preload/index.ts` |
| Local PTY | `src/main/pty/manager.ts`, `src/main/ipc/pty.ts` |
| SSH / SFTP / reconnect | `src/main/ssh/{manager,connection,knownHosts,osDetect,sftp,watch,quick-connect}.ts`, `src/main/ipc/ssh.ts` |
| tmux detach | `src/main/ssh/{tmux,detached-session}.ts`, UI `TmuxPicker` |
| Port forwards | `src/main/ssh/port-forward.ts`, `PortForwardPanel.tsx` |
| MCP | `src/main/mcp/{server,policy,tools,tools-browser,tools-agent}.ts` |
| Agent launch | `src/main/agent/{launch,context,extension,agent-bin,host-backend}.ts` + `*-launch.ts` |
| Agent UI | `AgentPane.tsx`, `agent-window.{html,tsx}`, `src/renderer/lib/agent-ui.ts`, `src/main/ipc/{agent,broadcast}.ts` |
| Approval / activity | `src/main/agent/{approval-rules,bridge-activity}.ts`, `AgentActivityPanel.tsx` |
| Search index | `src/main/search/*` |
| Git | `src/main/git/index.ts`, `src/renderer/components/git/*` |
| Transfers | `src/main/transfers/{queue,store}.ts`, `src/main/ipc/transfers.ts` |
| Session restore | `src/renderer/lib/session-restore.ts`, `src/main/ipc/session-restore.ts` |
| Sessions / layout / settings | `src/renderer/store/{sessions,layout,settings}.ts` |
| Terminal chrome | `TerminalLayout.tsx`, `TerminalView.tsx`, `RemoteSessionView.tsx`, `LocalSessionView.tsx`, `BrowserPane.tsx` |
| Themes / hotkeys / attention | `src/renderer/lib/{themes,hotkeys,attention}.ts` |
| Skills for this repo | `.claude/skills/{add-ipc,add-mcp-tool,verify,package-win}/SKILL.md` |

Session model (`store/sessions.ts`): `kind: 'local' | 'remote' | 'browser'`, plus `cwd`, agent fields, attention flags, `connectionId`, `groupId`.

Layout model (`store/layout.ts`): n-ary tree, `leaf` holds pane tabs, `split` is `row`/`col` with fractional sizes, `groups` hold independent trees.

---

## 4. Current known limits (the work is to lift these, in order)

From `AGENTS.md`, verified at plan-write time:

- Local PTYs die with the app. No local detach/reattach across quit.
- Restore MVP: local shells, saved SSH, browser panes at latest URL, agents, and editors survive. **Missing:** extra in-pane browser tabs, ad-hoc SSH, terminal scrollback.
- Transfers do not resume mid-file across restarts. Queue concurrency is 2.
- Single bastion hop (`profile.jump`). No ProxyJump chains.
- No block-based terminal UI (OSC 133 A/B only, no C/D).
- No inline images / sixel. No OSC 9/99 attention protocol.
- Mount-everything × renderer cost. No auto-hibernate of hidden groups.
- Electron 29 locked by node-pty prebuilt ABI. Upgrade is a project, not a bump.
- Open issues: **#1** command syntax highlighting (cannot be done honestly on a raw PTY), **#2** preview/annotate mode (not shipped).
- No MCP tools for git / search / forwards — agents shell out via `run_command`.
- Windows installer is unsigned.

---

## 5. Release train

Implement **v1.4 completely** before v1.5. Do not cherry-pick v1.5 UI onto an unhibernated renderer.

| Release | Theme | Exit criterion |
| --- | --- | --- |
| **v1.4** | Quit is safe, 16 panes is fine | 3 groups / 12 panes / 2 agents; hide two groups; memory stays roughly flat after hibernate; quit + relaunch restores hosts **and** recent scrollback; mid-file transfer resumes |
| **v1.5** | The agent can see what you see | Input editor + block gutter on hooked shells; select output → agent; preview pane with comments sent to the pane agent; read-only `git_status` MCP tool |
| **v1.6** | Daily-driver polish | Low-memory preset, first-run checklist, connection tags, image-paste-to-agent, personal markdown skills, optional idle webhook; Electron-upgrade spike branch exists |

Bump `package.json` version only when the operator asks to cut a release. Do not tag or run `build:win` unless asked.

---

# Phase v1.4 — Performance + restore + trust basics

## v1.4-A. Hidden-group terminal hibernate

**Priority:** P0. Highest leverage item in the whole plan.

### Problem

Every session stays mounted by design so PTYs/SSH survive. The *xterm canvas + 10k scrollback* in the renderer is what burns RAM/CPU for hidden groups. The process in main can stay; the renderer terminal does not need to stay live.

### Required design

- **Do not** unmount `TerminalLayout`. **Do not** destroy PTY/SSH/agent processes when hibernating.
- Add a per-session renderer state: `live | hibernated` (name freely, keep it in `store/sessions.ts` or a dedicated `store/hibernate.ts`).
- Main process keeps a **bounded output ring buffer** per session (PTY and SSH data paths). While hibernated, the renderer does not receive full `pty:data:<id>` / `ssh:data:<id>` bursts — only a heartbeat / last-line / attention signals.
- Hibernate a session when **all** are true:
  - its group is not the active group (or the pane has been off-screen / in a hidden group longer than `hibernateAfterMs`, default 30s)
  - `needsAttention` is false
  - no dirty editor tied to that slot
  - agent in that pane is not `docked` and visible (hidden/floating agents may still hibernate the *shell* xterm)
- On group focus or pane show:
  - recreate the xterm instance in the existing `.term-slot`
  - replay the ring buffer (and any persisted scrollback snapshot)
  - resubscribe to live coalesced data
- Attention, unread output, taskbar flash, and agent chimes must keep working while hibernated (they are already partly main-driven for hidden/floating agents — extend that to shells).

### Files likely to change

- `src/main/ipc/coalesce.ts`
- `src/main/pty/manager.ts`, `src/main/ipc/pty.ts`
- `src/main/ssh/manager.ts`, `src/main/ipc/ssh.ts`
- `src/main/search/*` (index should still ingest from main, not from a live xterm)
- `src/renderer/store/{sessions,layout,settings}.ts`
- `src/renderer/components/TerminalLayout.tsx` and `TerminalView.tsx` / `LocalSessionView.tsx` / `RemoteSessionView.tsx`
- `src/shared/types.ts` + preload for any new IPC (`pty:hibernate`, `pty:replay`, snapshot APIs)

### Settings

Add under Settings → Performance (there is already on-demand `performance:snapshot`):

- `hibernateEnabled` (default true)
- `hibernateAfterMs` (default 30000)
- `outputRingLines` (default equal to scrollback clamp, cap 100k)

### Tests

- Unit: ring buffer drop-oldest, replay concatenation, “hidden + attention = do not hibernate.”
- Do not break `npm run test:grid`.
- Manual / self-test notes: open 8 local panes in two groups, switch away for 45s, confirm xterm instances for the hidden group were disposed and recreated on return with recent output intact.

### Done when

- Hidden groups after the timer no longer keep a live xterm.
- Revealing a group replays output without a blank flash longer than one frame if possible, and never loses the PTY.
- Memory for 12 idle panes is materially lower than pre-change (use `performance:snapshot`).
- Invariants 1, 5, 10 still hold.

---

## v1.4-B. Idle poll pause (SFTP + git)

**Priority:** P0. Small. Do with or immediately after A.

### Behavior

- Pause remote SFTP listing poll (2500ms) and git `on-change` poll (5s) for sessions whose group is hidden **or** whose terminal is hibernated.
- On focus: one immediate refresh, then resume polling.
- Transfers and in-flight agent host tools are unaffected.

### Files

- `src/main/ssh/watch.ts`, `src/main/ssh/sftp.ts`
- `src/main/git/index.ts`
- renderer git hooks / `FileExplorer` watch subscribers

### Done when

- A hidden remote group produces no SFTP/git poll traffic (log or test spy).
- Focusing the group refreshes listings without a manual refresh button becoming the primary path (`AGENTS.md` forbids that).

---

## v1.4-C. Lazy workspace / restore connect

**Priority:** P0.

### Problem

Restoring a 4×4 remote workspace stampede-connects every SSH client at once.

### Behavior

1. Paint chrome, group tabs, and tab labels immediately from the restore snapshot.
2. Connect the **active group** first (all of its remotes).
3. Background groups connect on first focus, **or** on a stagger (250–400ms) after the active group is up — make this a setting, default “connect on focus” for remotes, stagger local PTYs immediately (cheap).
4. Restore toast becomes a live progress list: `3/8 hosts up`, errors inline, click focuses the failed tab.

### Files

- `src/renderer/lib/session-restore.ts`
- `src/main/ipc/session-restore.ts`
- workspace launch path used by Connections / Workspaces views
- `CreateGridModal.tsx` / `lib/createGrid.ts` (grids launched fresh should also stagger remotes)

### Done when

- A workspace with ≥6 remotes does not open 6 ssh2 clients in the same tick.
- Failed hosts do not block other hosts.
- Existing restore of agents/editors/browser URLs still runs.

---

## v1.4-D. Restore scrollback + ad-hoc SSH + extra browser tabs

**Priority:** P0.

### Scrollback

- Persist last N lines (default 2000, cap 10k) per session to `userData` (existing session-restore JSON or a sibling file keyed by session/connection).
- Strip ANSI the same way the search index does at ingest, but **store raw or ANSI-preserving data** so replay looks like the terminal, not plain text.
- On restore: feed into the xterm (or into the hibernate ring, then replay).
- Do not persist 100k lines. Bound disk per session.

### Ad-hoc SSH

- Today only **saved** connections restore. Persist enough of an unsaved profile (host, user, port, jump, auth *method*, key path — **never** password in the restore file; passwords stay in keychain under a generated id) so restore can reconnect.
- If the secret is missing, restore the tab in a “needs auth” state and prompt.

### Browser tabs

- Persist the list of tabs in a browser pane, not only `session.url`.
- Restore each tab URL; agent-owned (`AGT`) tabs restore as operator tabs unless the agent is also restored and re-attaches.

### Files

- `src/renderer/lib/session-restore.ts`
- `src/main/ipc/session-restore.ts`
- `src/main/search/*` if sharing the persistence path
- `BrowserPane.tsx`, browser IPC

### Done when

- Quit with an unsaved SSH tab + typed output + two browser tabs; relaunch; all three come back (SSH may ask for password if not in keychain).
- `AGENTS.md` Known limits paragraph about restore is updated.

---

## v1.4-E. Local “stay resident” (quit UI, keep PTYs) — scoped MVP

**Priority:** P1. Do not attempt “survive reboot” for local PTYs.

### Scope that is allowed

- Setting: **Keep sessions running in the tray** (default **off** until stable).
- Closing the window hides to tray; main process, local PTYs, SSH clients, and agents stay alive.
- Clicking tray / second-instance lock already exists — reuse it to show the window and reattach renderers (via hibernate replay).
- Explicit **Quit DevTerm** kills everything as today (tree-kill local PTYs).

### Scope that is forbidden in v1.4

- Surviving OS reboot for local PTYs.
- A separate PTY supervisor executable.
- Fake “reattach to a dead ConPTY.”

Remote tmux detach is already shipped; do not regress it. Reconnect should still re-attach tmux only if the operator was inside that session.

### Files

- `src/main/index.ts` window lifecycle
- `src/main/pty/manager.ts`
- session-restore (this path is “never tore down,” not “wrote a snapshot”)
- settings store

### Done when

- With the setting on: X the window, agents keep running, reopen, same PTYs (same ids if possible) stream again.
- With the setting off: behavior unchanged.
- Installer unlock logic still only kills `DevTerm.exe` descendants on uninstall/upgrade (`CHANGELOG` 1.3.5–1.3.7).

---

## v1.4-F. SFTP transfer mid-file resume

**Priority:** P1.

### Behavior

- Persist `(id, direction, localPath, remotePath, bytesDone, total, mtimeOrSize, session/connection id)` in `src/main/transfers/store.ts`.
- On app start, incomplete items show as paused “Resume.”
- Resume uses SFTP offset / append; verify local size matches `bytesDone` before continuing. If the remote file changed size/mtime unexpectedly, fail with a clear error and do not overwrite.
- Concurrency stays 2 unless you have a measured reason to change it.
- Cancel still deletes or leaves partials consistently (pick one, document in UI: leave partial + `.partial` suffix is safer).

### Files

- `src/main/transfers/{queue,store}.ts`
- `src/main/ipc/transfers.ts`
- `src/main/ssh/sftp.ts`
- transfers panel UI

### Tests

- Fake SFTP offset write/read.
- Restart mid-transfer fixture if one exists; otherwise unit the store rehydrate path.

### Done when

- Kill the app during a multi-MB download; reopen; Resume continues from `bytesDone`, not zero.

---

## v1.4-G. System SSH agent (OpenSSH / 1Password / Bitwarden)

**Priority:** P1. This is personal key hygiene, not SSO.

### Behavior

- Connection option: **Use system SSH agent** (default: on when no key/password is set).
- Windows: `ssh2` agent via named pipe `\\.\pipe\openssh-ssh-agent`.
- If agent auth fails, surface a specific error (“system agent has no usable key”) and keep password/key file paths working as today.
- Do not start shipping a DevTerm-only ssh-agent daemon.

### Files

- `src/main/ssh/connection.ts`, `quick-connect.ts`, profile types in `src/shared/types.ts`
- Connections form UI
- tests around connect option construction

### Done when

- A connection with no privateKey/password and agent enabled attempts agent auth first.
- Keychain-saved passwords still work when the operator chose password auth.

---

## v1.4-H. Select → send to agent

**Priority:** P1. Small UX, unblocks v1.5 comments.

### Behavior

- xterm selection context menu + command palette action: **Ask agent about this**.
- If the pane has no agent, `ensureAgent` (see `src/renderer/lib/agent-ui.ts`) then inject.
- Payload injected into the agent PTY is quoted text plus a short header:

  ```
  Operator selection from <tab-label> (<local|user@host>, cwd)
  ----
  <verbatim selection>
  ----
  ```

- Also works from the file editor selection.
- Do not auto-run. This is context, then the operator’s follow-up prompt (or a default “explain / fix”).

### Files

- `TerminalView.tsx` / xterm context menu
- `EditorView.tsx`
- `src/renderer/lib/agent-ui.ts`
- `src/renderer/lib/hotkeys.ts` + palette actions
- maybe `src/main/ipc/agent.ts` if injection must go through main

### Done when

- Select a stack trace in a remote pane → action → docked/hidden/floating agent receives the quote.
- Works when the agent UI is floating (broadcast rules already exist; use them).

---

## v1.4-I. Performance presets

**Priority:** P2. Depends on A.

### Settings → Performance

- **Balanced** (default): hibernate 30s, scrollback 10k, search 2k, SFTP poll on visible only.
- **Low memory:** hibernate 10s, scrollback 2k, search 1k, remotes connect-on-focus only.
- **Full fidelity:** hibernate off, scrollback up to the existing clamp.

Expose the existing `performance:snapshot` as a readable panel (already polled ~3s while that settings page is open — keep it on-demand, never upload).

---

# Phase v1.5 — Agent sees what you see

Do not start this phase until v1.4-A and v1.4-D work.

## v1.5-A. Optional input editor + command block gutters (issue #1)

**Priority:** P0 for v1.5.

### Honest scope

You **cannot** syntax-highlight the live PTY input line the way zsh does. The shell owns the line. Issue #1 is resolved by an **optional input editor** anchored on OSC 133 `;B`, plus block gutters from A/B markers — not by painting tokens into xterm.

### Phase behavior

- When prompt hooks are healthy (same signal autosuggest already uses in `lib/autosuggest.ts`):
  - show a one-line editor for the *next* command
  - syntax highlight **that editor** with a lightweight highlighter (reuse CodeMirror or a small tokenizer; do not pull a new framework)
  - accepting sends keystrokes to the shell, never writes into the xterm buffer (same rule as autosuggest)
- Up-arrow / Ctrl+R stay with the shell unless you explicitly implement history bridging; do not break existing history.
- Completed commands (A then B seen) get a faint gutter. Click gutter → Copy / Ask agent / Comment (comment is stored locally and included next time that pane’s agent is prompted).
- If hooks are missing, hide the editor and do nothing. No fake highlighting.

### Out of scope until C/D exists

- Exit-code coloring of blocks.
- Full Warp block canvas.

### Files

- `src/renderer/lib/autosuggest.ts`, `Autosuggest.tsx`
- new `src/renderer/lib/command-blocks.ts` + small component
- `TerminalView.tsx`
- shell-integration setup on local + remote (do not regress tmux DCS / stray `]` — tests in `detached-session.test.ts`)

### Done when

- On a hooked local pwsh and a hooked remote bash/zsh: the input editor highlights `git commit` style tokens.
- A pane without hooks looks exactly as today.
- Issue #1 can be closed with a comment that raw-PTY highlighting is explicitly not coming.

---

## v1.5-B. Preview + annotate mode (issue #2)

**Priority:** P0 for v1.5. Largest new feature. Keep it small.

### What to build

A **Preview pane** that shows the running app (or static files) with pins/comments that become agent context.

### Behavior

1. Actions: **Preview localhost port**, **Preview forwarded port**, **Preview this folder** (static files served by main on `127.0.0.1:<random>`).
2. Reuse the hardened in-app browser (`persist:browser`, http(s)/about:blank only). Remote apps are previewed via existing `-L` forwards, never by installing a preview server on the remote.
3. Overlay tools: pin, rectangle, text comment. Store JSON at `userData/annotations/<sessionId>.json` (`{id, x, y, w, h, body, createdAt, screenshotRef?}`).
4. **Send comments to agent** uses the same injection path as v1.4-H, plus an optional screenshot from existing `browser_screenshot`.
5. Heuristic “detect likely port” from cwd (`package.json` scripts, common vite/next ports) is nice-to-have, not required for MVP.

### New MCP tools (use `.claude/skills/add-mcp-tool`)

Register in `src/main/mcp/tools-browser.ts` or a new `tools-preview.ts`, guard in `policy.ts`:

| Tool | Purpose |
| --- | --- |
| `preview_open` | Open/focus a preview pane for a url or local folder |
| `preview_snapshot` | Return comments + optional screenshot. Banner **UNTRUSTED** like `browser_snapshot` |
| `preview_comments` | List or add a comment (add may be operator-only if policy says so) |

Password fields and URL guard rules reuse the browser policy ladder. Snapshots stay untrusted.

### Files

- new renderer `PreviewPane.tsx` or a mode on `BrowserPane.tsx`
- `src/main/browser/*`
- `src/main/mcp/tools-browser.ts`, `policy.ts`
- `src/main/ssh/port-forward.ts` if “preview this remote port” should ensure a `-L`
- settings toggle if you need to disable agent preview tools (default on, same as browser tools)

### Done when

- Operator can open a local Vite app in Preview, drop two comments, send to the pane agent, and the agent PTY receives comments + snapshot reference.
- Issue #2 can be closed or reduced to polish tickets.
- No preview server is spawned on the remote host.

---

## v1.5-C. Agent cockpit as switchboard

**Priority:** P1.

Cockpit already exists (`Ctrl/Cmd+Alt+A`). Extend it:

- Rows: last task line, running/idle, cwd, host, agent kind letter, age, UI mode.
- Actions already present (show / float / restart / stop) stay.
- New: **Focus pane**, **Delegate** (local only — call existing `agent_delegate` tools / `tools-agent.ts`).
- Drag a cockpit row onto a pane tab to focus or delegate (if drag is messy, skip drag and ship buttons).

### Files

- cockpit component (search `AgentOverview` / agents hotkey in renderer)
- `src/renderer/lib/agent-ui.ts`
- `src/main/mcp/tools-agent.ts` (no new remote handoff)

### Done when

- Three running agents can be restarted/stopped/focused without hunting tabs.

---

## v1.5-D. Read-only git + search MCP tools

**Priority:** P1.

Agents already fake this with `run_command`. Give them structured read tools. **Do not** add `git_push` / `git_commit` tools.

| Tool | Notes |
| --- | --- |
| `git_status` | Reuse `src/main/git/index.ts` against the session’s backend (local fs or SSH exec) |
| `git_diff` | Named files or full; cap size like `read_file` |
| `search_terminals` | Query `src/main/search/*`; return session id + snippets |

Policy: treat as read. Existing approval-rule prefixes still apply if you route them through the same pre-check.

### Files

- new `src/main/mcp/tools-workspace.ts` (or similar)
- `src/main/mcp/policy.ts`
- `.claude/skills/add-mcp-tool/SKILL.md`

### Done when

- A remote DevTerm Agent can call `git_status` without `run_command git status`.
- Push/commit still require the Git panel or an explicit `run_command` the CLI itself prompts on.

---

## v1.5-E. Multi-hop ProxyJump (cap 3)

**Priority:** P2.

- Change `profile.jump` from a single hop to an array of 1–2 extra hops (total hops ≤ 3 including target).
- UI: “Add jump host” on the connection form. Import from `~/.ssh/config` `ProxyJump` lists when parsing (`src/main/ssh/ssh-config-parse.ts`).
- No mesh, no dynamic jump graph.

### Done when

- `Host → bastion → target` and `Host → jump1 → jump2 → target` connect in tests or a documented manual path.
- Existing single-jump profiles still load.

---

# Phase v1.6 — Polish

Start after v1.5-A and v1.5-B.

## v1.6-A. First-run checklist

Replace the sticky “Getting started” hint with a four-step checklist that dies after success and **must not** be resurrected by settings import (`AGENTS.md` already requires this for the hint):

1. Open a local terminal
2. Import `~/.ssh/config` or save a connection
3. Open Agent once
4. Pick a theme

## v1.6-B. Connection folders / tags

Local-only tags (`prod`, `homelab`, `clients`, free text). Filter in Connections and in the command palette ranking (pinned > last used > tag match > name). No sync service.

## v1.6-C. Image paste → agent

Detect paste of image data in the agent pane or main window while an agent is focused. Write a temp PNG into the agent overlay / operator folder and inject a path mention. Full sixel rendering in xterm is **out of scope**.

## v1.6-D. Personal markdown skills

- Load instruction-only skills from a user folder (e.g. `%APPDATA%/devterm/skills/*.md` or `~/DevTerm/skills`).
- Reuse `trustedSkills` SHA-256 pin; re-hash every launch.
- Executable third-party extensions stay disabled.

## v1.6-E. Leave-mode notify (no mobile app)

When an agent goes idle-after-burst or needs approval:

- existing toast / OS notification / taskbar flash stay
- optional webhook URL or Telegram bot token in Settings (operator-provided, stored in keychain if secret)

Do not build Feishu/Discord bridges.

## v1.6-F. Electron upgrade spike (branch only)

Create a branch `spike/electron-upgrade`. Record:

- node-pty ABI situation (`@homebridge/node-pty-prebuilt-multiarch` vs vendored ConPTY)
- webview breakage
- `asarUnpack` + agent nested `node_modules` (`scripts/agent-closure-pack.cjs`, afterPack)
- unpackaged `npm run dev` smoke

Do **not** merge until natives and packaged agent boot are proven. Electron 29 stays on `main` until then.

## v1.6-G. Authenticode / SmartScreen note

If the operator has a cert, wire `CSC_*` into the documented release flow. If not, add README language only — do not fake a signature.

---

# 6. Implementation rules for every change

1. Match existing code style. Do not reformat unrelated files. Baseline lint findings stay; fix yours.
2. Three-layer IPC or it does not exist.
3. Streaming channels use per-id suffixes (`pty:data:<id>`, `ssh:data:<id>`, `agent:bridge-status:<id>`, …) and the coalescer.
4. Zod at IPC/MCP boundaries where the file you are in already does that.
5. Theme via CSS variables. No hard-coded purple chrome.
6. Windows is the shipping platform. Do not break ConPTY, Win32-OpenSSH path mapping (`C:\Users` ↔ `/C/Users`), or installer unlock behavior.
7. Do not plant agent config files in the operator’s project tree (overlays only). Local briefings stay in prompt flags.
8. Browser navigation: http(s)/about:blank only.
9. MCP tool results that include page or host text keep the UNTRUSTED banner where browser snapshots already do.
10. Update `CHANGELOG.md` under an `Unreleased` section (create it if missing) for user-visible changes.
11. Update `AGENTS.md` code map / known limits when architecture moves.

---

# 7. Suggested commit slicing (v1.4)

Make each commit buildable.

1. `feat(term): main-side output ring buffer and data gating for hidden groups`
2. `feat(term): dispose and restore xterm on hidden-group hibernate`
3. `feat(fs): pause SFTP and git polls on hidden groups`
4. `feat(session): lazy connect remotes on restore and workspace launch`
5. `feat(session): persist scrollback tail and ad-hoc SSH drafts`
6. `feat(browser): restore all tabs in a browser pane`
7. `feat(app): optional tray-stay-resident without killing PTYs`
8. `feat(sftp): resume incomplete transfers from persisted offset`
9. `feat(ssh): system ssh-agent auth option`
10. `feat(agent): send terminal/editor selection to agent`
11. `feat(settings): performance presets`
12. `docs: AGENTS.md known limits + CHANGELOG unreleased`

---

# 8. Suggested commit slicing (v1.5)

1. `feat(term): OSC 133 input editor and command block gutters`
2. `feat(preview): preview pane with annotation overlay`
3. `feat(mcp): preview_open / preview_snapshot / preview_comments`
4. `feat(agent): cockpit focus + local delegate actions`
5. `feat(mcp): read-only git_status, git_diff, search_terminals`
6. `feat(ssh): ProxyJump chain up to 3 hops`
7. `docs: close-out notes for issues #1 and #2`

---

# 9. Test plan (minimum)

Required after every item:

```sh
npm run typecheck
npm run test
npm run test:grid
```

When touching natives, SSH, PTY, or packaging scripts, also:

```sh
node scripts/smoke.cjs
```

When the operator asks for a packaged confidence check (do not do this unsolicited):

```sh
npm run build
npx electron . --self-test
```

### Behavioral regression list (touch if you edited that area)

- Local PTY starts on Windows without `OpenConsole.exe` (in-box ConPTY default).
- Remote POSIX inject does not echo a blob and does not `clear` MOTD.
- tmux picker attach is not `exec`; prefix+d returns to login shell.
- Stray `]` does not appear on tmux-wrapped prompts (`detached-session.test.ts`).
- Windows remote `run_command` follows OSC 7 cwd via PowerShell wrapper.
- Agent hide/float does not kill the process; Stop does.
- `agent:open` without `forceRestart` does not spawn a second agent of the same kind.
- Floating agent window still receives confirms and PTY data (broadcast).
- Closing a tab with a running agent or dirty editor still prompts.
- Settings import does not resurrect the welcome checklist.
- Packaged agent still resolves nested `pi-coding-agent` deps if you touched `scripts/*pack*`.

---

# 10. Competitor features — allowed theft vs rejection

Use this when tempted to “just add what Warp has.”

| Steal (adapt into DevTerm) | Reject |
| --- | --- |
| Warp: command blocks, select output → agent, multi-agent overview | Warp: cloud sync, teams, credits, vendor-only agent |
| Wave: durable remotes, inline file/image *as agent context* | Wave: rebuild the terminal as a block IDE |
| Termius: host tags, system ssh-agent | Termius: mobile, team vaults |
| Chaterm: `@host`-style addressing later, personal skills | Chaterm: accounts, infra knowledge base, K8s plugins |
| AgentTerm: idle notify | AgentTerm: chat-platform remote control product |

---

# 11. Open GitHub issues — how they get closed

### #1 Syntax highlight

**Close only after v1.5-A.** Closing comment must state: highlighting applies to the optional input editor and editor files; the raw PTY stream remains the shell’s. `cat` of a file can keep using the existing CodeMirror path (open in editor) rather than a PTY highlighter.

### #2 Preview mode

**Close only after v1.5-B MVP.** Follow-ups (better port detect, drawing tools) can be new issues.

Do not implement unrelated issues that appear later unless they block a phase exit criterion.

---

# 12. Performance budget (v1.4 exit)

Measure with Settings → Performance snapshot, nothing uploaded.

| Scenario | Target (guidance, not a CI gate) |
| --- | --- |
| 1 local pane idle | roughly unchanged vs 1.3.30 |
| 12 panes / 3 groups, 2 groups hidden 2+ min | hidden groups drop renderer terminal cost; RSS should not scale linearly with 12 live xterms |
| Restore 8 saved SSH | active group connects first; others on focus or stagger |
| 30 min idle mixed workspace | no SFTP/git poll on hidden remotes |

If a change misses the target, do not “fix” it by unmounting `TerminalLayout` or switching to WebGL.

---

# 13. Security checklist (every MCP / browser / SSH change)

- Loopback + bearer still required to call MCP.
- Approval rules remain a **pre-check** (`src/main/agent/approval-rules.ts`). Do not reintroduce a per-session Policy picker.
- Browser tools: operator tabs still need `browser_attach`; grants die on Stop/close.
- Preview snapshots untrusted.
- TOFU mismatches still rejected.
- Secrets: keychain / `safeStorage` only. Restore files and workspaces contain no passwords.
- Skills: instruction-only + SHA-256 pin.

---

# 14. What “done” for the whole plan means

The plan is complete when:

1. v1.4 exit criterion in §5 is met and documented in `CHANGELOG.md`.
2. v1.5 exit criterion is met; issues #1 and #2 are closed with the scoping comments in §11.
3. v1.6-A through v1.6-E exist or are explicitly deferred by the operator in this file’s progress log.
4. `AGENTS.md` known limits no longer list hibernate, mid-file transfer resume, or restore-without-scrollback as current facts.

---

# 15. Operator preferences (already stated)

- Not enterprise. No SSO.
- Vision: ultimate terminal for people who work on remote and local machines with AI agents.
- Windows is the product. macOS/Linux remaining “dev build works” is acceptable until the operator says otherwise.
- Prefer polishing the unique MCP-on-same-SSH design over cloning Warp’s entire UI.

If a new request conflicts with §1 or §2, stop and ask the operator.

---

# 16. Gates (copy/paste)

```sh
npm run typecheck
npm run lint          # fix only what you introduced
npm run test
npm run test:grid
node scripts/smoke.cjs
```

IPC/MCP additions: follow `.claude/skills/add-ipc/SKILL.md` or `.claude/skills/add-mcp-tool/SKILL.md`.

---

# Progress log

_Agents: append dated bullets. Do not rewrite history._

- 2026-09-19 — Plan written against v1.3.30. No implementation started in this file’s lifetime.
- 2026-09-21 — Prompt 7 (v1.4-F): incomplete SFTP transfers rehydrate as paused, keep a `.partial` file, and resume from the persisted offset after source size/mtime and partial-size checks. Concurrency stays 2. Cancel/double-finish guards retained.
- 2026-09-21 — Prompt 8 (v1.4-G): per-connection “Use system SSH agent” (default on when no key/password). Windows uses `\\.\pipe\openssh-ssh-agent`. Agent-only failures surface “system agent has no usable key”. Password and key-file auth unchanged when chosen.
- 2026-09-21 — Prompt 9 (v1.4-H): “Ask agent about this” from xterm selection, command palette, and the file editor. `ensureAgent` then injects a quoted header + verbatim selection; no auto-fix. Floating agent PTYs receive the inject through the existing main-side write/broadcast path.
- 2026-09-21 — Prompt 10 (v1.4-I): Settings → System performance presets (Balanced / Low memory / Full fidelity) set hibernate, scrollback, search index size, and remote connect mode. `performance:snapshot` remains on-demand while that page is open.
- 2026-09-21 — Prompt 11 (v1.4 wrap-up): v1.4 items A–I are in tree (hibernate, poll pause, lazy restore connect, scrollback/ad-hoc/browser-tab restore, tray stay-resident, transfer resume, system ssh-agent, select→agent, performance presets). Exit criterion “memory stays roughly flat after hibernate” is a Settings snapshot guidance check, not a CI gate. Package version left at 1.3.30; no tag.
- 2026-09-21 — Prompt 12 (v1.5-A): optional OSC 133 command input editor (shell highlighter, Enter sends keystrokes) and A-then-B gutters with Copy / Ask agent / Comment. Missing hooks keep today’s UI. No C/D exit coloring and no Warp block canvas. `detached-session.test.ts` still owns the tmux DCS / stray `]` contract.
- 2026-09-21 — Prompts 13–20 (v1.5-B through v1.6-E): preview pane + annotations + MCP preview tools; cockpit focus/delegate; read-only `git_status`/`git_diff`/`search_terminals`; ProxyJump chains capped at 3 hops; first-run checklist + connection tags; image paste to agent artifacts; personal markdown skills folder; optional idle/approval webhook + Telegram. Package version left at 1.3.30; no tag. Prompt 21 (Electron upgrade spike) is a separate `spike/electron-upgrade` branch with `SPIKE.md`.
- 2026-09-21 — Prompt 18 (v1.5 wrap-up): v1.5-A–E are in tree. Issue #1 close comment: highlighting lives on the OSC 133 input editor and CodeMirror files; the raw PTY stream stays the shell’s. Issue #2 close comment: preview + annotate MVP shipped (localhost / forwarded port / local folder, overlay comments, send to agent, MCP tools); leftover polish is port heuristics and richer drawing tools.
- 2026-09-21 — Cut **v1.4.0** (installer + GitHub release). Ships v1.4 A–I, v1.5 A–E, and v1.6 A–E in one build. Electron-upgrade spike stays on `spike/electron-upgrade`. Package version bumped from 1.3.30.
- 2026-09-21 — **v1.4.1**: removed the bottom OSC 133 command input strip; packed the app logo as real extraResource/extraFile PNGs/ICOs (window, tray, NSIS, next to the exe).

---

# Appendix A — First item to implement if you can only do one thing

**v1.4-A Hidden-group terminal hibernate**, then **v1.4-B idle poll pause**.

Everything else in the vision gets cheaper once hidden terminals stop being live canvases. Do not start Preview, blocks, or multi-hop before that if you are a single agent with limited context.

# Appendix B — Explicit out-of-scope backlog (do not implement unless operator promotes it)

- Mosh / UDP roaming
- OSC 9/99 attention protocol
- Full sixel / iTerm inline image protocol in xterm
- Multi-window workspaces (two BrowserWindows × mount-everything)
- Serial / X11
- Cloud model proxy inside DevTerm
- Bundled marketplace of agent skills
- Auto-update trust UX beyond existing `electron-updater`
- Replacing ssh2 with a forked OpenSSH child as the primary transport
