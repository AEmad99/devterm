---
name: add-mcp-tool
description: Guided workflow for adding a new agent tool to the DevTerm MCP bridge, wired through its policy guardrail. Use when adding a capability the embedded Pi agent can call.
---

Add a new MCP tool that the embedded `pi` CLI can call (via its per-session MCP extension) over the in-process MCP server. Follow the existing patterns — read the files before editing.

1. **Read `src/main/mcp/tools.ts`** to match how existing tools are defined (name, zod input schema, handler, return shape). MCP tools register against the server in `src/main/mcp/server.ts`.
2. **Define the new tool** alongside the others: a clear `name`, a `zod` schema for inputs (this repo validates tool input with zod), and a handler. Reuse existing helpers (SSH manager, local fs) rather than reimplementing access.
3. **Wire the guardrail in `src/main/mcp/policy.ts`.** Every tool that runs commands or mutates state must respect the per-host policy mode (`read_only` / `confirm` / `full`). Decide:
   - Is this tool read-only or mutating? Read-only tools may bypass the destructive-command checks; mutating ones must not.
   - Does it need the destructive-op approval flow (renderer `ConfirmActionModal`, 2-min timeout)? If it can delete/overwrite/shut down, route it through confirmation like the existing destructive paths.
4. **Keep the security boundary.** The agent is untrusted input — never let a tool escape the policy mode for its host. Don't add a tool that runs arbitrary shell outside the `policy.ts` checks.
5. Run `npm run typecheck` and, if relevant, exercise the tool via the agent pane in `npm run dev`.

Ask the user for the tool's purpose, inputs, and whether it's read-only or mutating before writing code if those aren't already clear.
