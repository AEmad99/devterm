# DevTerm — Feature Implementation Plans

**Date:** 2026-06-25  
**Status (2026-09-02):** Global terminal search is **shipped**. Remote tmux detach/reattach
(picker + attach without `exec`) is **shipped**. Session-restore MVP (local + saved SSH)
and `~/.ssh/config` import are **shipped**. Local PTY detach/reattach across app quit
is **still open**. Prefer `AGENTS.md` + code over this file when they disagree.

**Features:** 
1. Built-in tmux-like session persistence (even when disconnected)
2. Global terminal search (across panes + history)

---

## 1. Built-in tmux-like Session Persistence

### Problem
When a user disconnects (close laptop, network drop, sleep), the `node-pty` process and SSH connection are destroyed. The user loses scrollback, running processes, and session state. No way to re-attach.

### Goals
- Allow users to **detach** from running terminals without killing them.
- Provide **reattach** on next launch (or on explicit reconnect).
- Survive app restart, OS sleep, or SSH network blips when possible.
- Feel as close as possible to real `tmux` / `screen` without requiring the remote host to have tmux installed.

### Architecture Overview

#### For **Local Terminals**
- Use a **long-lived PTY server** process (separate from the renderer).
- On detach: keep PTY alive in the main process, buffer output.
- On reattach/restart: spawn a **new PTY** that reads the previous session's scrollback + current working directory, then continues.
- Store session state to disk: PTY metadata + scrollback snapshot.

#### For **Remote (SSH) Terminals**
- This is harder because the remote shell runs on the server.
- Options:
  1. **Preferred:** Automatically start `tmux` / `screen` on the remote side (if available) and wrap the user's shell inside it. Hide the tmux control keys from the user.
  2. **Fallback:** Local-side SSH reconnection + re-spawn + try to restore working directory and limited scrollback.
- Store which remote sessions are "tmux-wrapped" vs raw.

### Data Model Additions

New store / IPC types needed:

```ts
interface PersistedSession {
  id: string
  kind: 'local' | 'remote'
  connectionId?: string          // for SSH
  startCwd?: string
  scrollback: string[]           // last N lines
  env?: Record<string, string>
  detachedAt: string             // ISO timestamp
  tmuxSessionName?: string       // if we wrapped with tmux
}
```

Persistence file: `userData/persisted-sessions.json`.

### Implementation Plan (Step-by-Step)

#### Phase 1 — Local Terminal Persistence (MVP)
1. Create `src/main/pty/persistence.ts`.
2. Modify `PtyManager` to:
   - Keep PTYs alive when the renderer tab closes.
   - Buffer output (circular buffer).
   - Expose `detach(ptyId)` and `reattach(ptyId)`.
3. Add a new menu item / context menu: **"Detach Terminal"**.
4. On app restart, auto-restore detached sessions into a special "Restored" group.
5. Add `Session.closed` + new `detached` flag.

#### Phase 2 — Remote + tmux Integration
1. Detect `tmux` or `screen` availability on connection.
2. On session create: if remote and tmux available, run `tmux new-session -d -s devterm-xxx` then attach inside it.
3. Store tmux session name.
4. Provide UI toggle: "Use remote tmux when available".
5. On reattach: `tmux attach -t devterm-xxx`.

#### Phase 3 — Polish
- Restore scrollback visually (show previous output dimmed when reattaching).
- Add "Kill detached session" button.
- Auto-cleanup after N days.
- Keyboard shortcut: `Ctrl+Shift+D` → Detach.

### Files Likely Needing Changes
- `src/main/pty/manager.ts`
- `src/main/ipc/pty.ts`
- `src/renderer/store/sessions.ts`
- `src/renderer/components/TerminalLayout.tsx`
- `src/renderer/components/TerminalView.tsx`
- New: `src/main/pty/persistence.ts`

---

## 2. Global Terminal Search

### Problem
Users open dozens of panes. Finding a previous command or output requires manually switching tabs and scrolling. No cross-pane or cross-session search exists.

### Goals
- Search **all open terminals** + **history** in one place.
- Show results with context (pane name, timestamp, line).
- Jump directly to the matching pane + scroll position.
- Include both live output and persisted scrollback from detached sessions.

### Architecture Overview

Use a **centralized search index** in the main process.

- Live terminals stream output into an in-memory search index.
- Closed/detached terminals load scrollback from disk into the index.
- Renderer calls `search:query` IPC with debounce.
- Results are returned as lightweight `{ sessionId, lineIndex, text, timestamp }`.

### Data Model

```ts
interface SearchResult {
  sessionId: string
  sessionTitle: string
  lineNumber: number
  text: string
  timestamp?: string
  kind: 'live' | 'history' | 'detached'
}
```

### Implementation Plan (Step-by-Step)

#### Phase 1 — Basic Global Search (MVP)
1. Create a **Search Index** service in main (`src/main/search/index.ts`).
2. Use a simple in-memory map + optional `fuse.js` or `minisearch` for fuzzy search.
3. Terminal output listener (`pty:on-data`) pushes lines into the index.
4. Add a global hotkey → opens a floating `GlobalSearchModal`.
5. Search modal calls `window.api.search.query(text)`.
6. Render list of matches; clicking a result focuses the pane and scrolls.

#### Phase 2 — History + Detached Sessions
1. Persist terminal scrollback (or at least recent commands) alongside existing history store.
2. On startup, load last 500 lines of every persisted session into the search index.
3. Show badge: "42 results across 7 sessions".
4. Add filters: "Only current workspace", "Only SSH sessions", "Last 24h".

#### Phase 3 — Advanced Polish
- Highlight matched text in results.
- Regex mode toggle.
- "Search in current pane only" quick filter.
- Add search to command palette (`Ctrl+Shift+F` everywhere).

### Files Likely Needing Changes
- New: `src/main/search/index.ts`
- New: `src/renderer/components/GlobalSearchModal.tsx`
- `src/main/ipc/pty.ts` (hook into data stream)
- `src/renderer/lib/hotkeys.ts`
- `src/renderer/store/sessions.ts` (for session titles)
- Possibly extend `SearchBar.tsx`

---

## Recommended Order of Implementation

1. **Start with Global Terminal Search (MVP)** — smaller surface, immediate UX win.
2. **Local Terminal Persistence** — solvable without touching remote SSH complexity.
3. **Remote + tmux wrapping** — harder, requires good detection + graceful fallback.
4. Add polish, shortcuts, and cleanup for both features.

---

## Open Questions for the Author

- Should detached remote sessions keep the SSH connection alive in the background? (might be resource-heavy)
- Do you want a hard limit on total scrollback kept for search (memory vs completeness)?
- Should the global search also index **commands sent by the Claude agent** (separate channel)?

---

*End of plan document.*