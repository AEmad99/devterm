# DevTerm — Prompts for the implementing agent

Put `DEVTERM-AGENT-IMPLEMENTATION-PLAN.md` in the repo root (or keep both files in the working tree) before you start. The agent should also read `AGENTS.md`.

Use **one prompt per session**. Do not paste the next prompt until the previous item has `typecheck` + tests green and a changelog note.

---

## Prompt 0 — Session bootstrap (use this first, every new agent / new chat)

```
You are implementing DevTerm (repo AEmad99/devterm), an Electron 29 + React 19 + TypeScript desktop SSH/SFTP terminal with a built-in multi-provider coding agent.

Read these before writing any code:
1. AGENTS.md (architecture, invariants, code map — code wins if docs drift)
2. DEVTERM-AGENT-IMPLEMENTATION-PLAN.md (what to build and in what order)
3. CHANGELOG.md (recent regressions — do not reintroduce them)

Hard rules:
- Never unmount TerminalLayout or reparent xterm DOM slots. Hidden groups use .term-hidden, never display:none.
- Agent hide/float/dock must not kill the process. Only Stop / tab close / quit does.
- One primary ssh2.Client per normal remote; Windows OpenSSH compatibility mode is the documented exception.
- Canvas xterm renderer stays. No WebGL.
- IPC changes must edit src/shared/types.ts, src/main/ipc/* (registered from src/main/index.ts), and src/preload/index.ts together.
- Never npm rebuild node-pty. Never plain npm install.
- No SSO, cloud sync, mobile app, RDP, plugins, or IDE features.
- Windows is the shipping platform. Do not break ConPTY, Win32-OpenSSH path mapping, tmux attach-not-exec, or POSIX inject (no clear, deferred ${__dtA}/${__dtB}).

Your job in this chat is only the task I give you next. Do not start later phases. When you finish: npm run typecheck && npm run test && npm run test:grid, add an Unreleased note in CHANGELOG.md if user-visible, update AGENTS.md known limits if you lifted one, and append a dated bullet to the plan file Progress log.

Wait for the specific task prompt.
```

---

## Prompt 1 — v1.4-A part 1: main-side output ring buffer

```
Task: v1.4-A part 1 from DEVTERM-AGENT-IMPLEMENTATION-PLAN.md
Implement a bounded per-session output ring buffer in main for local PTY and SSH shell data.

Requirements:
- Buffer lives in main, not the renderer.
- Cap is configurable (default = current scrollback, hard cap 100000 lines or equivalent bytes). Drop oldest.
- Existing live streaming to the renderer must keep working unchanged for visible sessions.
- Search index must continue to ingest from main (ANSI strip at ingest stays).
- Use the existing IPC coalescer (src/main/ipc/coalesce.ts). Add a way to gate full data bursts to the renderer later; for this commit, the API can exist but default to "always forward" so nothing hibernates yet.

Do not dispose xterm yet. Do not change layout mounting.

Add unit tests for drop-oldest and replay concatenation.

Gates: npm run typecheck && npm run test && npm run test:grid
Commit message if asked: feat(term): main-side output ring buffer and data gating hook
```

---

## Prompt 2 — v1.4-A part 2: hibernate hidden-group xterms

```
Task: v1.4-A part 2 from DEVTERM-AGENT-IMPLEMENTATION-PLAN.md
Hibernate renderer terminals for hidden groups without killing PTY/SSH/agent processes.

Requirements:
- Never unmount TerminalLayout. Never reparent slots. Never display:none on a live slot.
- After hibernateAfterMs (default 30000) in a non-active group, dispose the xterm instance in that .term-slot, keep the slot.
- While hibernated, main keeps the ring buffer + process alive and does not flood the renderer with full pty:data/ssh:data. Attention, unread, and agent chimes must still work.
- Do not hibernate if needsAttention is set, or a dirty editor is in that slot.
- On group focus / pane show: recreate xterm in the same slot, replay the ring buffer, resubscribe to live data. No PTY/SSH reconnect just because of hibernate.
- Settings → Performance: hibernateEnabled (default true), hibernateAfterMs, outputRingLines.
- Hidden/floating agents may hibernate the sibling shell xterm; do not kill the agent PTY.

Tests: hidden + attention = do not hibernate; replay after dispose. Do not break npm run test:grid.

Manual check notes in the PR/commit body: 8 local panes / 2 groups, switch away 45s, hidden xterms disposed, return restores recent output.

Gates: npm run typecheck && npm run test && npm run test:grid
Update AGENTS.md known limits: mount-everything still true for processes; renderer hibernate now exists.
Commit message if asked: feat(term): dispose and restore xterm on hidden-group hibernate
```

---

## Prompt 3 — v1.4-B: pause SFTP + git polls on hidden groups

```
Task: v1.4-B from DEVTERM-AGENT-IMPLEMENTATION-PLAN.md
Pause remote SFTP listing polls (2500ms) and git on-change polls (5s) for sessions in hidden or hibernated groups.

On group/pane focus: one immediate refresh, then resume. Do not add a manual refresh button as the primary path.
In-flight transfers and agent host tools stay unaffected.

Gates: npm run typecheck && npm run test
Commit message if asked: feat(fs): pause SFTP and git polls on hidden groups
```

---

## Prompt 4 — v1.4-C: lazy restore / workspace connect

```
Task: v1.4-C from DEVTERM-AGENT-IMPLEMENTATION-PLAN.md
Stop stampede-connecting every remote when restoring a session or launching a workspace/grid.

Behavior:
1. Paint chrome, group tabs, and tab labels immediately from the snapshot.
2. Connect the active group's remotes first.
3. Background remotes connect on first focus (default) or on a 250–400ms stagger — setting, default connect-on-focus for remotes. Local PTYs can start immediately.
4. Restore toast becomes live progress (e.g. 3/8 hosts up) with errors inline; click focuses the failed tab.
5. Failed hosts must not block others. Existing restore of agents, editors, and browser URLs must still run.

Touch session-restore, workspace launch, and createGrid remote spawn if it currently connects every cell at once.

Gates: npm run typecheck && npm run test && npm run test:grid
Commit message if asked: feat(session): lazy connect remotes on restore and workspace launch
```

---

## Prompt 5 — v1.4-D: persist scrollback, ad-hoc SSH, extra browser tabs

```
Task: v1.4-D from DEVTERM-AGENT-IMPLEMENTATION-PLAN.md
Finish session restore so quit is not a punishment.

1. Persist last N lines of scrollback per session (default 2000, cap 10000) under userData. Store ANSI-preserving data so replay looks like the terminal. Bound disk. On restore, feed the tail into the ring buffer / xterm.
2. Persist unsaved (ad-hoc) SSH profiles enough to reconnect: host, user, port, jump, auth method, key path. Never write passwords into the restore file. If the secret is missing, restore the tab in a needs-auth state and prompt. Passwords stay in the OS keychain under a generated id if already saved.
3. Persist all tabs in a browser pane, not only session.url. Agent-owned AGT tabs restore as operator tabs unless the agent is also restored and re-attaches.

Do not claim local PTYs survive process death. That is a later task.

Update AGENTS.md known limits for restore.

Gates: npm run typecheck && npm run test
Commit message if asked: feat(session): persist scrollback tail, ad-hoc SSH drafts, and browser tabs
```

---

## Prompt 6 — v1.4-E: tray stay-resident (optional)

```
Task: v1.4-E from DEVTERM-AGENT-IMPLEMENTATION-PLAN.md
Add a setting "Keep sessions running in the tray" default OFF.

When ON: closing the window hides to tray; main process, local PTYs, SSH clients, and agents stay alive. Reopening reattaches renderers via the hibernate replay path. Same session ids if possible.
When OFF: current quit behavior unchanged.
Explicit Quit DevTerm still tree-kills local PTYs as today.

Forbidden: survive reboot, a separate supervisor exe, faking reattach to a dead ConPTY.
Do not regress remote tmux detach/reattach or installer process-unlock behavior (only DevTerm.exe descendants).

Gates: npm run typecheck && npm run test && node scripts/smoke.cjs
Commit message if asked: feat(app): optional tray-stay-resident without killing PTYs
```

---

## Prompt 7 — v1.4-F: SFTP transfer resume

```
Task: v1.4-F from DEVTERM-AGENT-IMPLEMENTATION-PLAN.md
Resume incomplete SFTP transfers across app restarts.

Persist id, direction, localPath, remotePath, bytesDone, total, mtime/size, session/connection id in the transfer store.
On start, incomplete items appear paused with Resume.
Resume uses SFTP offset; verify local size matches bytesDone. If remote mtime/size is unexpected, fail clearly and do not overwrite.
Concurrency stays 2.
Define partial-file policy (prefer leave partial with a .partial suffix) and make the UI match.

Unit-test store rehydrate + offset continue. Do not break cancel/double-finish guards.

Gates: npm run typecheck && npm run test
Commit message if asked: feat(sftp): resume incomplete transfers from persisted offset
```

---

## Prompt 8 — v1.4-G: system SSH agent

```
Task: v1.4-G from DEVTERM-AGENT-IMPLEMENTATION-PLAN.md
Add a per-connection option "Use system SSH agent" (default on when no key or password is set).

Windows: ssh2 agent auth via named pipe \\.\pipe\openssh-ssh-agent.
If agent auth fails, error must say the system agent has no usable key. Password and key-file auth keep working when the operator chose them.
Do not ship a DevTerm-only ssh-agent daemon. This is not SSO.

Gates: npm run typecheck && npm run test
Commit message if asked: feat(ssh): system ssh-agent auth option
```

---

## Prompt 9 — v1.4-H: select → send to agent

```
Task: v1.4-H from DEVTERM-AGENT-IMPLEMENTATION-PLAN.md
Add "Ask agent about this" from xterm selection (context menu + command palette) and from the file editor selection.

If the pane has no agent, ensureAgent then inject.
Inject into the agent PTY a short header (tab label, local|user@host, cwd) plus verbatim selection. Do not auto-run a fix.
Must work when the agent UI is floating (use existing broadcast / confirm paths).
Reuse src/renderer/lib/agent-ui.ts.

Gates: npm run typecheck && npm run test
Commit message if asked: feat(agent): send terminal and editor selection to agent
```

---

## Prompt 10 — v1.4-I: performance presets

```
Task: v1.4-I from DEVTERM-AGENT-IMPLEMENTATION-PLAN.md
Settings → Performance presets wired to the hibernate + scrollback + search + lazy-connect settings you already added:

- Balanced (default): hibernate 30s, scrollback 10k, search 2k, SFTP poll visible-only
- Low memory: hibernate 10s, scrollback 2k, search 1k, remotes connect-on-focus only
- Full fidelity: hibernate off, scrollback at existing clamp

Keep performance:snapshot on-demand only. Nothing sampled in background. Nothing uploaded.

Gates: npm run typecheck && npm run test
Commit message if asked: feat(settings): performance presets
```

---

## Prompt 11 — v1.4 wrap-up docs

```
Task: v1.4 documentation pass only. No feature work.

Update AGENTS.md known limits and code map for hibernate, restore contents, transfer resume, ssh-agent, tray stay-resident, and performance presets.
Ensure CHANGELOG.md Unreleased lists every user-visible v1.4 item that actually shipped.
Append a v1.4 completion bullet to the plan Progress log stating which exit criteria are met and which were deferred.

Do not bump package.json or tag a release unless I say so.
```

---

## Prompt 12 — v1.5-A: input editor + command block gutters (issue #1)

```
Task: v1.5-A from DEVTERM-AGENT-IMPLEMENTATION-PLAN.md
Resolve issue #1 honestly. Do not syntax-highlight the raw PTY input line.

When OSC 133 hooks are healthy (same signal autosuggest uses):
- Show a one-line input editor for the next command.
- Syntax-highlight THAT editor only (CodeMirror or a small tokenizer; no new framework).
- Accepting sends keystrokes to the shell, never writes into the xterm buffer (same rule as autosuggest).
- Completed commands (A then B) get a faint gutter. Click gutter: Copy / Ask agent / Comment (comment stored locally, included next time that pane's agent is prompted).

If hooks are missing, hide the editor. UI must match today.
Do not break up-arrow/Ctrl+R shell history.
Do not regress tmux DCS / stray ] — detached-session.test.ts must stay green.
No exit-code coloring until OSC 133 C/D exists. Do not build a Warp block canvas.

Gates: npm run typecheck && npm run test
Commit message if asked: feat(term): OSC 133 input editor and command block gutters
```

---

## Prompt 13 — v1.5-B part 1: Preview pane + annotations (issue #2)

```
Task: v1.5-B part 1 from DEVTERM-AGENT-IMPLEMENTATION-PLAN.md
Build Preview + annotate UI. No new MCP tools in this prompt.

Actions: Preview localhost port, Preview forwarded port, Preview this folder (static files served by main on 127.0.0.1 random port).
Reuse the hardened in-app browser (persist:browser, http(s)/about:blank only). Remote apps preview via existing -L forwards. Never spawn a preview server on the remote.

Overlay: pin, rectangle, text comment. Persist JSON at userData/annotations/<sessionId>.json.
"Send comments to agent" uses the v1.4-H injection path plus optional browser_screenshot.

Port-detect heuristics from package.json are optional, not required.

Gates: npm run typecheck && npm run test
Commit message if asked: feat(preview): preview pane with annotation overlay
```

---

## Prompt 14 — v1.5-B part 2: preview MCP tools

```
Task: v1.5-B part 2 from DEVTERM-AGENT-IMPLEMENTATION-PLAN.md
Follow .claude/skills/add-mcp-tool/SKILL.md.

Add MCP tools, guarded in policy.ts:
- preview_open — open/focus a preview pane for a url or local folder
- preview_snapshot — comments + optional screenshot, UNTRUSTED banner like browser_snapshot
- preview_comments — list comments; add may be operator-only if policy requires

Reuse browser URL guard and password policy ladder.
Local and remote agents may use these; preview itself is always local (forwarded port for remotes).

Gates: npm run typecheck && npm run test
Commit message if asked: feat(mcp): preview_open, preview_snapshot, preview_comments
```

---

## Prompt 15 — v1.5-C: agent cockpit switchboard

```
Task: v1.5-C from DEVTERM-AGENT-IMPLEMENTATION-PLAN.md
Extend the existing agent overview cockpit (Ctrl/Cmd+Alt+A).

Each row: last task, running/idle, cwd, host, kind letter, age, UI mode.
Keep show / float / restart / stop.
Add Focus pane and Delegate (local only, existing agent_delegate / tools-agent.ts). No remote handoff tools.
Skip drag-and-drop if it fights the layout; buttons are enough.

Gates: npm run typecheck && npm run test
Commit message if asked: feat(agent): cockpit focus and local delegate actions
```

---

## Prompt 16 — v1.5-D: read-only git + search MCP tools

```
Task: v1.5-D from DEVTERM-AGENT-IMPLEMENTATION-PLAN.md
Follow .claude/skills/add-mcp-tool/SKILL.md.

Add read-only tools:
- git_status — reuse src/main/git/index.ts (local fs or SSH exec)
- git_diff — named files or full, size-capped like read_file
- search_terminals — query src/main/search, return session id + snippets

Do NOT add git_commit or git_push tools. Mutating git stays in the Git panel or explicit run_command.
Approval-rule pre-check still applies.

Gates: npm run typecheck && npm run test
Commit message if asked: feat(mcp): read-only git_status, git_diff, search_terminals
```

---

## Prompt 17 — v1.5-E: ProxyJump chains (cap 3)

```
Task: v1.5-E from DEVTERM-AGENT-IMPLEMENTATION-PLAN.md
Change profile.jump from a single hop to a list. Max 3 hops including the target (1–2 jump hosts).

Connection form: Add jump host. Import ~/.ssh/config ProxyJump lists in ssh-config-parse.ts.
Existing single-jump profiles must still load.
No mesh VPN.

Gates: npm run typecheck && npm run test
Commit message if asked: feat(ssh): ProxyJump chain up to 3 hops
```

---

## Prompt 18 — v1.5 wrap-up + close issues

```
Task: v1.5 documentation only.

Update AGENTS.md and CHANGELOG Unreleased.
In the plan Progress log, record v1.5 exit status.

Draft (do not post unless I ask) closing comments:
- Issue #1: highlighting lives on the optional OSC 133 input editor and CodeMirror files; raw PTY stream stays the shell's.
- Issue #2: preview + annotate MVP shipped; list leftover polish as new issues if any.

Do not bump version or tag.
```

---

## Prompt 19 — v1.6-A + B: first-run + connection tags

```
Task: v1.6-A and v1.6-B from DEVTERM-AGENT-IMPLEMENTATION-PLAN.md

Replace the sticky Getting started hint with a four-step checklist that disappears after success and must NOT come back on settings import:
1. Open a local terminal
2. Import ~/.ssh/config or save a connection
3. Open Agent once
4. Pick a theme

Add local-only connection tags/folders. Filter in Connections and rank in the command palette: pinned > last used > tag match > name. No cloud sync.

Gates: npm run typecheck && npm run test
```

---

## Prompt 20 — v1.6-C + D + E: image paste, skills folder, idle webhook

```
Task: v1.6-C, v1.6-D, and v1.6-E from DEVTERM-AGENT-IMPLEMENTATION-PLAN.md

C: Paste image while an agent is focused → write a temp PNG into the agent overlay or operator folder and inject the path. No sixel renderer.

D: Load instruction-only markdown skills from the user skills folder (userData/skills or ~/DevTerm/skills). Reuse trustedSkills SHA-256 pin, re-hash every launch. Executable third-party extensions stay disabled.

E: Optional webhook URL or Telegram bot token (secret in keychain) fired when an agent goes idle-after-burst or needs approval. Existing toasts/taskbar stay. No Feishu/Discord product.

Gates: npm run typecheck && npm run test
```

---

## Prompt 21 — v1.6-F: Electron upgrade spike (branch only)

```
Task: v1.6-F from DEVTERM-AGENT-IMPLEMENTATION-PLAN.md
Create branch spike/electron-upgrade. Do not merge to main.

Investigate what an Electron major bump would break:
- node-pty prebuilt ABI (@homebridge/node-pty-prebuilt-multiarch vs vendored ConPTY)
- webview
- asarUnpack + agent nested node_modules (scripts/agent-closure-pack.cjs, afterPack)
- npm run dev smoke

Write findings as SPIKE.md on that branch. Leave package.json on main at Electron 29.
```

---

## How to run this

1. New chat → Prompt 0 → immediately Prompt 1.
2. Same chat can continue to Prompt 2 only if context is still healthy (files not confused). If the agent starts wandering, new chat: Prompt 0 + the next numbered prompt and “do not redo earlier items unless tests are red.”
3. After Prompt 11, you can cut a v1.4 release yourself. Do not let the agent tag unless you ask.
4. Never send Prompts 12+ before hibernate (Prompt 2) works. Preview on an unhibernated 4×4 grid will make the app heavier, not better.
