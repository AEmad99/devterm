# DevTerm Premium Audit — v1.3.20

Date: 2026-09-08. Full competitive + UI/UX audit with gap analysis and 30/60/90-day roadmap.

**Verdict: strong prosumer terminal with a real moat, not premium/enterprise-grade yet.**
The zero-install remote agent (self-hosted MCP bridge, nothing installed on the remote,
no remote internet needed) plus a built-in multi-provider agent with 7 CLI fallbacks is
genuinely differentiated. But MFA/OTP, SSO, audit, sync, SSH certificates, and RBAC are
absent in code — not just undocumented — and those are enterprise deal-blockers.

**Premium-readiness: 58/100** (premium bar ≈ 85+).

| Dimension | Score | Basis |
|---|---|---|
| Terminal + tiling | 9/10 | N-ary tree, never-unmount slots, focus/zen, 4x4 grid |
| SSH/SFTP depth | 5/10 | ssh2 + TOFU + transfers work; OTP and CA absent |
| Editor / git / search | 7/10 | Real surface; git is a single file (depth flag) |
| Agent + MCP | 8/10 | Built-in agent, approval rules; zero-install is unique |
| Theme / hotkey engines | 8/10 | Typed 10-theme engine, 28-id remappable registry |
| CSS hygiene | 4/10 | panels.css 4659 lines + chrome 1519 + terminal 1394 |
| Sync / teams | 1/10 | Local-only; settings:sync is localStorage to file |
| SSO / MFA / audit / RBAC | 0/10 | Zero modules; OTP + CA absent in code |
| Monetization plumbing | 1/10 | MIT, no license/seat/flag/trial code |
| Release / reliability | 4/10 | Single-channel updater, no crash reporter |

Decisions:

1. OTP/keyboard-interactive is P0 #1 — MFA/Duo servers cannot connect at all,
   and ssh2 already supports it; the app just never wires it.
2. SSO + audit + sync sell as a bundle behind entitlements; build them together.
3. Do NOT rewrite themes, hotkeys, or layout — all three are verified production
   engines; fix edges only.
4. Split the CSS monolith before any visual restyle.
5. Lead every competitive pitch with zero-install remote + agent; that is the moat.

## 1. Complete feature inventory (as built)

**Terminal + tiling.** Local shells via node-pty (auto/pwsh/powershell/cmd/custom,
PowerShell prompt hooks on Windows, startup-failure diagnostics). OSC 7 cwd + OSC 133
prompt markers, including tmux DCS wrapping. Canvas renderer by design (WebGL's
~16-context cap blanked always-mounted panes), DOM fallback, 10k scrollback
(clamp 100–100k). N-ary split tree with named groups (inactive groups stay
mounted-hidden via `.term-hidden`, never `display:none`), stable per-session slots
never reparented, focus mode, zen mode, 4x4 remote grid (each cell its own ssh2
client), tab-label compression, per-pane find, OSC 133-anchored autosuggest with
keystroke inject.

**SSH + connections.** ssh2-based, one client per session shared by
shell/SFTP/exec/watch/git/agent. Key + password auth only. TOFU host keys in
`known_hosts.json` (mode 0600, SHA256 per host:port, mismatch rejected with operator
dialog). Saved connections, workspaces, session restore, single bastion hop.

**SFTP / files / transfers.** File explorer following shell cwd (local fs / remote SFTP
on same client), live listings via `FsApi.watch()`, dual-pane SFTP browser, persistent
transfer queue (concurrency 2, survives restarts, no mid-file resume), CodeMirror 6
overlay editor (5 MiB cap, EOL preserved, sanitized Markdown preview).

**Git panel.** Full read + write (status/diff/log/branches/remotes/stash/tags/blame/show,
checkout/branch/fetch/pull/push/commit/stage/discard/tag/remote/merge), remote ops over
the session exec channel, 5s poll, status-cache invalidation, graph view. Caveat: all in
one `git/index.ts` — a depth/maintainability flag.

**Agent bridge.** Bundled multi-provider agent + 7 external CLI fallbacks (pi, claude,
opencode, kimi, grok, codex, antigravity), each in a local PTY reaching the remote only
through the in-process MCP bridge on 127.0.0.1 with a random bearer token. Remote agents
get host tools (`ping`, `get_host_context`, `run_command`, `list_dir`, `read_file`,
`write_file`); local agents use CLI-native tools. 11 browser tools with agent-owned vs
operator-tab consent model, ref-tag snapshots with UNTRUSTED banner. Approval-rules
pre-check (allow/deny/ask) at the MCP boundary, no per-session picker. UI modes
docked/hidden/floating (separate OS window); process lifetime != UI placement;
idempotent `agent:open` unless `forceRestart`; activity log exportable as JSONL.
Provider keys never cross IPC; model failover on 408/429/5xx; SHA-256-pinned
instruction-only skills.

**Search / palette / snippets / dictation / browser.** Global in-memory search
(2000 lines/session, ANSI stripped at ingest, optional persistent JSONL tail).
Command palette (Ctrl/Cmd+K) with fuzzy+frecency across
actions/snippets/connections/workspaces/history, incl. PSReadLine continuation
reassembly. Snippets with `{{placeholders}}`, local-only. Renderer-only Whisper
dictation (WebGPU to WASM, push-to-talk). In-app `<webview>` panes on hardened
`persist:browser` partition, per-origin zoom, throttled download progress.

**Settings / theme / window.** Settings in `localStorage` mirrored to
`userData/settings.json`; export/import strips secrets and merges through normalizers.
One 10-theme engine drives chrome + xterm via CSS vars; framed opaque window; 28-id
remappable hotkey registry; background throttling off; electron-updater single channel
from GitHub, skipped in dev.

## 2. Biggest competitors and their premium features

Researched current (Sept 2026): Warp, iTerm2, Tabby, MobaXterm, Termius, SecureCRT,
WindTerm, WezTerm, VS Code Remote-SSH.

### Warp (Free / Build $20 / Max $200 / Business $50u)

Premium: Rust+wgpu block terminal, agent + cloud + BYOK with credits,
transcript/history/command search, shared Drives + workflows, account sync, SSO on
Business/Enterprise. Weaknesses vs DevTerm: no session manager, no SFTP, sys-ssh only.
**DevTerm beats Warp on SFTP, saved sessions, and zero-footprint remote.**

### Termius (Free / Pro ~$10 / Teams)

Premium: best SMB-team package — E2EE all-device sync, hosts + chains, vaults +
sharing, 2FA + keyboard-interactive + SSO on Teams, SFTP, port-forward rules with sync,
iOS/Android apps, API + CLI. **The sync/mobile/teams combo is the biggest
competitive gap.**

### SecureCRT (~$99-129, regulated-industry standard)

Premium: deep sessions + proxy + Kerberos, keyboard-interactive + smartcard + GSSAPI,
X.509/OpenSSH certs with revocation, serial/Telnet, SecureFX deep file transfer,
Python/VB scripting, FIPS mode, AD integration + logging. **The certs/serial/compliance
combo is the enterprise gap.**

### MobaXterm (Win Free / Pro ~69 EUR)

Premium: deep session tree, net-share sync, sidebar SFTP + drag-drop, port-forward
wizard + X11, serial, MobaEditor, macros, seat licensing.
**The Windows all-in-one + X11 + serial story.**

### iTerm2 (macOS, free/GPL)

Premium: Metal rendering, inline images, tabs/panes + tmux control + broadcast,
profiles + status + restore, Python API + AppleScript, smart selection + triggers +
copymode. Prosumer/mac-only, no sync, no teams.
**DevTerm beats it on cross-platform + SFTP + agent.**

### Tabby (free OSS)

Premium: profiles + jump hosts + X11, keyboard-interactive/2FA, SFTP browser,
serial/telnet, port-forward UI, deep theming, plugins + CLI, Tabby.sh/self-hosted sync.
**Closest OSS rival; DevTerm's agent+MCP is the reason to switch.**

### WindTerm (free)

Premium: fast C++, sessions + agent, keyboard-interactive, SFTP, serial, history +
filter. Prosumer, manual sync, no teams/SSO.

### WezTerm (free MIT)

Premium: Rust GPU terminal, tabs/panes + SSH mux, Lua deep configurability, overlay +
regex search, dotfile sync. Hacker tool, no SFTP/serial/sync/teams.

### VS Code Remote-SSH (free + Copilot $10)

Premium: full IDE on remote, auto port-forwarding + ports view, ripgrep + history
search, MS/GitHub settings sync, org SSO + audit via GitHub Enterprise,
extension/task APIs, LiveShare/Codespaces, tunnel/web.
**Costs a server install + download on every remote — zero-install beats it.**

Bottom line: DevTerm beats Warp on sessions/SFTP/footprint, iTerm2/WezTerm on
cross-platform/SFTP/agent, VS Code Remote on zero-install, and Tabby/WindTerm on
agent+MCP. It loses to Termius (sync/mobile/teams), SecureCRT (certs/serial/FIPS),
MobaXterm (Win/X11/serial), and every enterprise player on SSO/audit/RBAC.

## 3. Gap analysis — P0/P1/P2

Effort: S <= 1 wk, M 2-4 wk, L 1-3 mo.

**P0 — deal-blockers (fix before calling it premium):**

- **P0-1 OTP / keyboard-interactive auth absent.** `connection.ts` auth config is
  key/password only, `connect()` has no `tryKeyboard`/`authHandler`, `SSHHop` has no
  OTP field, and `tryKeyboard|keyboard-interactive|totp` has zero hits in `src/`
  (verified) while the bundled ssh2 supports it. Fix: challenge loop with echo-aware
  prompt modal (memory-only secrets), per-hop MFA incl. Duo/push async path.
  Effort S-M. Impact: MFA fleets cannot connect at all.
- **P0-2 No SSO.** Zero auth modules/deps. Fix: `main/auth/{oidc,tokenStore,scim}.ts`,
  OIDC+PKCE first, SAML bridge second, keytar vault, org to workspace binding, SCIM.
  Effort L. Impact: procurement veto.
- **P0-3 No audit.** `bridge-activity` is observability, not audit. Fix:
  `main/audit/{log,sign,ship}.ts`, hash-chained JSONL (who/what/where, approvals,
  conn open/close, transfer hashes), ship + export + retention. Effort M.
  Impact: SOC2/HIPAA blocker.
- **P0-4 No sync.** `settings:sync` IPC just snapshots localStorage to local
  `settings.json`; export is manual; search tails are per-machine JSONL. Fix:
  `main/sync/{engine,crypto,conflict}.ts`, E2E sealed-box envelopes, device keys,
  LWW + conflict UI, offline queue; self-hosted relay first. Effort L.
  Impact: win-rate + retention (Termius/VSCode/Warp all sync).
- **P0-5 No licensing/entitlements.** MIT, no seat/flag/trial code. Fix:
  `main/license/{entitlement,seat,flags}.ts` + shared entitlements: Free/Pro/Team/Ent,
  flags (SSO/sync/audit/fleet), trial + offline grace, IPC + UI enforcement.
  Effort M. Impact: cannot sell premium.
- **P0-6 No SSH CA/certs.** TOFU exact-match only; no principals, expiry, or
  revocation. Fix: `ssh/{certAuthority,certVerify}.ts` with CA bundle, validity +
  critical-options checks, CRL, rotation UX. Effort M. Impact: cert-fleet blocker.
- **P0-7 No RBAC/teams.** Fix after P0-2/P0-5: Owner/Admin/Operator/Viewer,
  shared-vs-private workspaces, least-privilege (connect vs approve vs transfer).
  Effort M. Impact: team-deal blocker.

**P1 — bake-off losers:**

- **P1-1 Single-channel updater** (`--publish always`), no rings or offline bundles.
  Fix: stable/beta/nightly + staged rollout % + signed metadata + air-gap import. S-M.
- **P1-2 No crash reporting.** Fix: Sentry/self-hosted + crashReporter, scrubbed,
  opt-in, enterprise-disable. S.
- **P1-3 Port forwarding not first-class.** ssh2 can do it; no manager UI. Fix:
  forward manager (-L/-R/-D, reconnect, conflict detection). S-M.
- **P1-4 No serial console.** Fix: `main/serial/*` on `serialport`. M.
  (Tabby/Moba/SecureCRT parity.)
- **P1-5 SFTP depth unverified** (retry/resume, checksum, caps, diff-sync). M.
- **P1-6 Git is one file** — split into status/log/diff/branch/remote, large-repo
  perf, signing verify. M.
- **P1-7 Secrets handling ad hoc** — migrate to keytar vault, per-connection unlock,
  lock-on-idle, access audit. M.
- **P1-8 Accessibility gaps** — focus rings, per-region aria, Ctrl+1..n pane nav,
  contrast pass. S-M.

**P2 — differentiation / polish:** mobile approvals companion via signed relay (not a
full terminal) L; shared notebooks/workflows on top of sync L; palette generated from
the hotkey registry S; broadcast/fleet command + approve-once agent run across the 4x4
grid M (killer demo on zero-install); high-contrast themes + live preview +
system-follow S; dictation: promote to a main-process service or cut it S-M; portable
encrypted search index with sync M. Non-goals for v1: full mobile terminal, X server,
FIPS certification.

## 4. UI/UX audit — prototype smells to premium fixes

Three suspected "prototype" areas turned out to be **production engines — do not
rewrite them**. Theming is a typed `AnsiPalette` + `ChromeColors` + `Theme` with a
10-theme registry, fallback, ~22 CSS vars, luminance-aware readability, and xterm
transparency wiring. Hotkeys are a 28-id registry with overrides, normalization,
bare-modifier rejection, and mac-aware labels, persisted and validated. Layout is an
n-ary tree (note: AGENTS.md says "binary" — doc drift) with immutable helpers,
degenerate-guard layout, pending-gated reconcile, fresh-id restore, per-group
order-preserving sync, and tests.

The real prototype smells, with file-level fixes:

- **CSS monolith (confirmed, fix first).** `panels.css` 4659 lines + `chrome.css` 1519
  + `terminal.css` 1394 vs `base.css` 295 + `motion.css` 208 (verified). Split panels
  into per-area files (connections, transfers, files, git, workspaces, snippets,
  browser, agent, <=400 lines each) and chrome into window/tabs/layout/find; move all
  tokens to `:root` vars in base; add stylelint + dead-CSS CI gate; ban hex outside
  base; keep `.term-hidden` as the only slot-hiding mechanism (grep-ban `display:none`
  on `.term-slot`). Same pixels, sane architecture. Effort M.
- **Theming edges.** Add high-contrast light + dark registry entries with contrast
  tests (panels 4.5:1, terminal text 7:1); add a Settings live preview
  (surface/border/text/accent swatches + 16 ANSI chips); add OS system-follow; delete
  per-component hex bypasses after the CSS split. S.
- **Hotkey discoverability.** Generate the palette + Shortcuts modal from the registry
  (no second list to drift); add a remap UI with conflict detection + reset +
  import/export; surface hints on buttons/tooltips from the registry; make pane-nav ids
  (Ctrl+1..n) first-class. S.
- **Layout nits.** Replace the `Date.now()`-based id generator with
  `crypto.randomUUID`; codify a per-workspace layout model (sidebar/panel/dock, sizes,
  focus) with snap/min sizes; add aria-labels + focus rings in `TerminalLayout`
  (keeping the stable-slot/hidden/focused-slot invariants); fix the "binary" to "n-ary"
  doc drift. S.
- **Chrome / focus / zen / find hardening.** Audit `-webkit-app-region`,
  double-click maximize, tri-platform controls, 32-40px chrome height, traffic-light
  padding, tab overflow/ellipsis; find + autosuggest empty/no-match/wrap states,
  Esc-focus-return, accept/dismiss announcements, keyboard-only end-to-end;
  per-workspace focus/zen intent with announcements and an Esc order
  (find to focus to zen). S-M.
- **Premium-feel items beyond the code audit.** First-run onboarding (empty states
  currently assume expertise — add a guided connect + sample workspace); settings
  information architecture (group + search as the panel grows); consistent motion
  language on top of the existing reduced-motion guards; attention signals are already
  agent-oriented (chime + notification + badge) — keep them but add user-tunable
  granularity so they feel crafted, not noisy.

Do NOT do: rewriting themes/hotkeys/layout (4-6 weeks of burn that regresses working
code). Tokenize CSS, add the edges above, fund the P0s.

## 5. 30/60/90-day roadmap to premium

Assumes up to 3 workstreams (auth/audit/entitlements; ssh/certs/sync/transfers;
client/CSS/a11y). Single-threaded: do days 1-30 fully, then P0-2 to P0-3 to P0-4.

**Days 1-30 — "connects everywhere, releases safely."** Weeks 1-2: P0-1 OTP (challenge
modal, per-hop MFA; demo = a Duo server connects) in parallel with the CSS split +
stylelint gate. Weeks 2-3: updater channels (stable/beta + signed metadata + staged %)
and crash reporting. Weeks 3-4: entitlement skeleton (flags/trial/grace, Pro badge) +
keytar vault phase 1. Week 4: chrome/find hardening + doc fix + keyboard end-to-end.
Exit: MFA connects, beta + telemetry live, >=1 premium gate, CSS merged. Score ~ 66.

**Days 31-60 — "procurement says yes."** Weeks 5-7: SSO (OIDC+PKCE, vault, org binding)
+ RBAC v1 on entitlements, in parallel with SSH CA/certs. Weeks 6-8: audit v1
(hash-chained JSONL, approvals/connections/transfers, export; run a mock-SOC2 evidence
pass). Weeks 7-8: port-forward manager + palette-from-registry + high-contrast themes +
live preview + contrast tests. Exit: Okta/Entra login, deny states, cert-only connect,
audit export, forward UI. Get a security design-partner review. Score ~ 78.

**Days 61-90 — "follows me; obeys me."** Weeks 9-11: sync v1 (E2E envelopes for
connections/snippets/settings, device keys, offline queue, LWW + conflict UI;
self-hosted relay first) + portable search index — prove with 2-device sync and a
ciphertext capture — in parallel with serial console + SFTP depth. Weeks 10-11: git
split + large-repo perf + accessibility pass. Weeks 11-12: broadcast/fleet command +
approve-once agent run over the zero-install grid — the differentiator launch (one
approval to agent run across a 4x4 remote grid). Week 12: packaging —
Free/Pro/Team/Ent pricing mapped to SKUs, trial to paid loop, admin docs (SSO/SCIM,
retention, offline update, CA enrollment), Termius/SecureCRT importers. Exit: E2EE sync
live, serial + deep SFTP, fleet demo, pricing enforced, security packet done.
Score ~ 86 — premium bar cleared.

Risks: sync crypto needs external review before making E2E claims; keep SSO scoped
(OIDC to SAML bridge to SCIM, in that order); guard the CSS split with screenshot-diff
CI across 10 themes x focus/zen/find.

## Evidence notes

Feature inventory, engine line-refs, and competitor research came from a 12-agent sweep
(4-angle inventory/UX/competitor/enterprise-gap, critic round with follow-ups,
synthesis). Highest-leverage claims independently re-verified: `package.json` v1.3.20
MIT; CSS line counts match exactly; `tryKeyboard|keyboard-interactive|totp` returns
zero hits in `src/`; layout uses a `SplitNode` n-ary tree. Warp pricing checked current
as of 2026-09-08. Unverifiable items are labeled as such rather than asserted.
