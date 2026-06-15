import type { HostContext } from '@shared/types'

/**
 * The "## Working directory" briefing section, shared by both agent briefings.
 * The cwd follows the operator's shell live (pushed over `agent:set-cwd` and
 * read by the MCP tools), so the briefing names the launch directory and points
 * the agent at `get_host_context` for the current value rather than baking in a
 * path that can go stale.
 */
function workingDirSection(cwd: string | undefined): string {
  const where = cwd
    ? `Right now that is \`${cwd}\`.`
    : `It is not reported yet — call \`get_host_context\` once the operator's shell is active.`
  return `## Working directory
Your host tools act in the **operator's current terminal directory**, which
tracks their \`cd\` live — they don't need to spell out a path for "here". ${where}
- \`run_command\` already executes in this directory.
- Relative paths to \`read_file\` / \`write_file\` / \`list_dir\` resolve against it; pass an absolute path to act elsewhere.
- The live value is the \`cwd\` field of \`get_host_context\` — re-check it rather than assuming it stayed put.
`
}

/**
 * Per-session AGENTS.md describing the host so the agent steers itself —
 * crucially, the air-gapped/local-mirror rules so it never proposes internet
 * installs on disconnected fleet hosts (§2.3).
 *
 * pi auto-loads AGENTS.md from the cwd at startup, so the launch step writes
 * this file into the per-session temp directory.
 */
export function buildAgentsMd(context: HostContext, airGapped: boolean, cwd?: string): string {
  const osName =
    context.os === 'windows' ? 'Windows' : context.os === 'mac' ? 'macOS' : context.os === 'linux' ? 'Linux' : 'unknown OS'

  return `# Connected host: ${context.hostname}

You are operating on a **remote ${osName}** host through DevTerm's MCP bridge.

- Host: \`${context.hostname}\`
- OS: ${osName}
- Details: ${context.detail || '(unknown)'}

## How to act on this host
Use the \`mcp__devterm__*\` tools — they run on THIS host over the existing SSH
connection. Do not \`ssh\` elsewhere.
- \`mcp__devterm__run_command\` — run a shell command here.
- \`mcp__devterm__read_file\` / \`mcp__devterm__write_file\` / \`mcp__devterm__list_dir\` — files on this host.
- \`mcp__devterm__get_host_context\` — re-read these facts.
- \`mcp__devterm__ping\` — confirm the bridge is still alive.

The DevTerm MCP bridge is a real HTTP server on localhost; its bearer token is
in the \`DEVTERM_BRIDGE_TOKEN\` env var. The bridge enforces the operator's
policy (read-only / confirm / full) before running any tool, and destructive
operations may prompt the operator for approval.

${workingDirSection(cwd)}
## Built-in tools are disabled in this session
Read, write, edit, bash, grep, find, and ls are intentionally **off** — there
is no local checkout here. If you need a file on this host, use
\`mcp__devterm__read_file\` (or \`mcp__devterm__write_file\`); if you need to run
a command, use \`mcp__devterm__run_command\`. Anything that looks like a local
path is a path on the remote host, not on your machine.

${
  airGapped
    ? `## ⚠ AIR-GAPPED HOST — NO INTERNET
This host has **no outbound internet**. NEVER run \`yum\`/\`dnf\`/\`apt\`/\`pip\`/\`npm\`
against internet repos, and never \`curl\`/\`wget\` from the internet. Use the
**local mirrors only**: Harbor registry, Skopeo, \`oc mirror\`, and pre-staged
local repos. If something isn't mirrored, say so rather than attempting an
internet fetch.`
    : `## Network
This host has outbound internet, but prefer local/organisational mirrors when available.`
}

## Safety
Destructive operations are gated by an operator-approval guardrail. Explain what
a command does before running anything that changes state.
`
}

/**
 * Per-session CLAUDE.md describing the host so the Claude CLI steers itself.
 * Same intent as {@link buildAgentsMd}, but the Claude CLI keeps its built-in
 * Read/Write/Edit tools enabled (scoped via --allowedTools); those act on the
 * agent's local scratch dir, so the briefing steers all host work through the
 * `mcp__devterm__*` tools. Claude auto-loads CLAUDE.md from the cwd at startup,
 * so the launch step writes this file into the per-session temp directory.
 */
export function buildClaudeMd(context: HostContext, airGapped: boolean, cwd?: string): string {
  const osName =
    context.os === 'windows' ? 'Windows' : context.os === 'mac' ? 'macOS' : context.os === 'linux' ? 'Linux' : 'unknown OS'

  return `# Connected host: ${context.hostname}

You are operating on a **remote ${osName}** host through DevTerm's MCP bridge.

- Host: \`${context.hostname}\`
- OS: ${osName}
- Details: ${context.detail || '(unknown)'}

## How to act on this host
Use the \`mcp__devterm__*\` tools — they run on THIS host over the existing SSH
connection. Do not \`ssh\` elsewhere.
- \`mcp__devterm__run_command\` — run a shell command here.
- \`mcp__devterm__read_file\` / \`mcp__devterm__write_file\` / \`mcp__devterm__list_dir\` — files on this host.
- \`mcp__devterm__get_host_context\` — re-read these facts.

${workingDirSection(cwd)}
## Your built-in file tools act locally, not on the host
Your Read/Write/Edit tools operate on **this agent's own scratch directory**,
not on the remote host — there is no host checkout here. Anything that looks
like a local path is on your machine; for files on the connected host always use
\`mcp__devterm__read_file\` / \`mcp__devterm__write_file\`, and to run a command
use \`mcp__devterm__run_command\`.

${
  airGapped
    ? `## ⚠ AIR-GAPPED HOST — NO INTERNET
This host has **no outbound internet**. NEVER run \`yum\`/\`dnf\`/\`apt\`/\`pip\`/\`npm\`
against internet repos, and never \`curl\`/\`wget\` from the internet. Use the
**local mirrors only**: Harbor registry, Skopeo, \`oc mirror\`, and pre-staged
local repos. If something isn't mirrored, say so rather than attempting an
internet fetch.`
    : `## Network
This host has outbound internet, but prefer local/organisational mirrors when available.`
}

## Safety
Destructive operations are gated by an operator-approval guardrail. Explain what
a command does before running anything that changes state.
`
}
