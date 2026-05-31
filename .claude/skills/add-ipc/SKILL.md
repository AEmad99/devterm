---
name: add-ipc
description: Guided workflow for adding a new IPC command to DevTerm across the shared types, main-process handler, and preload bridge. Use when the renderer needs a new main-process capability.
---

Add a renderer↔main IPC command. Because of Electron's locked-down security model (`contextIsolation`, `nodeIntegration: false`, `sandbox: true`), every renderer capability must cross the typed `contextBridge` — there are three coordinated edits. Read each file first to match conventions.

1. **`src/shared/types.ts`** — add the channel name and its request/response types. This is the contract both sides import (alias `@shared`); define it here first so main and preload stay in sync.
2. **`src/main/ipc/`** — add the handler in the most relevant existing module (`pty`, `ssh`, `files`, `claude`, `connections`, `context`) or a new one, following the existing `ipcMain.handle`/registration pattern. Make sure it's registered from `src/main/index.ts` if you add a new module.
3. **`src/preload/index.ts`** — expose the call on the `contextBridge` API surface so the renderer can invoke it. The renderer can only see what preload exposes — nothing reaches it automatically.
4. **Renderer usage** — call it from the relevant component/store (`src/renderer/store/` or `components/`).
5. Run `npm run typecheck` — the shared types make a mismatch across the three layers a compile error, so this catches most wiring mistakes.

Never bypass this by giving the renderer Node access; keep everything behind the typed bridge. Ask the user what the command should do and its inputs/outputs if not already clear.
