import type { HostContext } from '@shared/types'

/**
 * The "## Working directory" briefing section, shared by all three agent
 * briefings (pi / claude / opencode). The cwd follows the operator's shell
 * live (pushed over `agent:set-cwd` and read by the MCP tools), so the
 * briefing names the launch directory and points the agent at
 * `get_host_context` for the current value rather than baking in a path
 * that can go stale.
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
    context.os === 'windows'
      ? 'Windows'
      : context.os === 'mac'
        ? 'macOS'
        : context.os === 'linux'
          ? 'Linux'
          : 'unknown OS'

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
    context.os === 'windows'
      ? 'Windows'
      : context.os === 'mac'
        ? 'macOS'
        : context.os === 'linux'
          ? 'Linux'
          : 'unknown OS'

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

/**
 * Per-session AGENTS.md describing the host for the OpenCode TUI.
 *
 * OpenCode is its own world vs. Claude/pi: the tools are exposed as
 * `devterm_<name>` (server-name prefix) — there is no `mcp__` segment —
 * and OpenCode ships its own built-in tools which the launch step disables
 * in `opencode.json`. The briefing tells the agent which prefixed tools to
 * reach for, mirrors the air-gapped/network rules, and steers it away from
 * trying to read or write files locally (the launch cwd is a throwaway
 * temp dir).
 */
export function buildOpencodeMd(context: HostContext, airGapped: boolean, cwd?: string): string {
  const osName =
    context.os === 'windows'
      ? 'Windows'
      : context.os === 'mac'
        ? 'macOS'
        : context.os === 'linux'
          ? 'Linux'
          : 'unknown OS'

  return `# Connected host: ${context.hostname}

You are operating on a **remote ${osName}** host through DevTerm's MCP bridge.

- Host: \`${context.hostname}\`
- OS: ${osName}
- Details: ${context.detail || '(unknown)'}

## How to act on this host
OpenCode exposes the bridge's tools as \`devterm_*\` (the MCP server is named
\`devterm\`). Use them — they run on THIS host over the existing SSH connection.
Do not \`ssh\` elsewhere, do not try to use a local checkout, and do not use any
built-in read/write/edit/bash tool (they are disabled in this session's config).
- \`devterm_run_command\` — run a shell command here.
- \`devterm_read_file\` / \`devterm_write_file\` / \`devterm_list_dir\` — files on this host.
- \`devterm_get_host_context\` — re-read these facts.
- \`devterm_ping\` — confirm the bridge is still alive.

The DevTerm MCP bridge is a real HTTP server on localhost; its bearer token is
in the bridge config OpenCode loaded. The bridge enforces the operator's
policy (read-only / confirm / full) before running any tool, and destructive
operations may prompt the operator for approval.

${workingDirSection(cwd)}
## Your working directory is a throwaway
The path you see on launch is a temp dir DevTerm uses only to hold the
\`opencode.json\` config and this briefing — it is **not** a checkout of the
remote host. Anything that looks like a local path is on your machine, not the
host; use the \`devterm_*\` tools for everything on the connected host.

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
 * Per-session AGENTS.md describing the host for the Kimi Code CLI.
 *
 * Kimi auto-loads `AGENTS.md` from the working directory (and walks up the
 * project hierarchy). It exposes the bridge's tools as `mcp__devterm__*`
 * (the MCP server is named `devterm`). The briefing tells the agent to use
 * those tools for host work and to treat the launch cwd as a throwaway temp
 * dir, not a checkout of the remote host.
 */
export function buildKimiMd(context: HostContext, airGapped: boolean, cwd?: string): string {
  const osName =
    context.os === 'windows'
      ? 'Windows'
      : context.os === 'mac'
        ? 'macOS'
        : context.os === 'linux'
          ? 'Linux'
          : 'unknown OS'

  return `# Connected host: ${context.hostname}

You are operating on a **remote ${osName}** host through DevTerm's MCP bridge.

- Host: \`${context.hostname}\`
- OS: ${osName}
- Details: ${context.detail || '(unknown)'}

## How to act on this host
Kimi exposes the bridge's tools as \`mcp__devterm__*\` (the MCP server is named
\`devterm\`). Use them — they run on THIS host over the existing SSH connection.
Do not \`ssh\` elsewhere, do not try to use a local checkout, and do not use any
built-in read/write/edit/bash tool for host work.
- \`mcp__devterm__run_command\` — run a shell command here.
- \`mcp__devterm__read_file\` / \`mcp__devterm__write_file\` / \`mcp__devterm__list_dir\` — files on this host.
- \`mcp__devterm__get_host_context\` — re-read these facts.
- \`mcp__devterm__ping\` — confirm the bridge is still alive.

The DevTerm MCP bridge is a real HTTP server on localhost; the \`mcp.json\` it
loaded contains the bearer token. The bridge enforces the operator's policy
(read-only / confirm / full) before running any tool, and destructive
operations may prompt the operator for approval.

${workingDirSection(cwd)}
## Your working directory is a throwaway
The path you see on launch is a temp dir DevTerm uses only to hold the
\`.kimi-code/mcp.json\` config and this briefing — it is **not** a checkout of
the remote host. Anything that looks like a local path is on your machine, not
the host; use the \`mcp__devterm__*\` tools for everything on the connected host.

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
 * Per-session AGENTS.md describing the host for the Grok TUI.
 *
 * Grok namespaces MCP tools as `devterm__<name>` (server `devterm`, tool
 * `run_command` → `devterm__run_command`). The launch step writes a
 * `.grok/config.toml` with the HTTP bridge entry and a `.claude/settings.json`
 * allow-list so built-in bash/read/edit tools stay off; this briefing steers
 * the model toward the prefixed tools for all host work.
 */
export function buildGrokMd(context: HostContext, airGapped: boolean, cwd?: string): string {
  const osName =
    context.os === 'windows'
      ? 'Windows'
      : context.os === 'mac'
        ? 'macOS'
        : context.os === 'linux'
          ? 'Linux'
          : 'unknown OS'

  return `# Connected host: ${context.hostname}

You are operating on a **remote ${osName}** host through DevTerm's MCP bridge.

- Host: \`${context.hostname}\`
- OS: ${osName}
- Details: ${context.detail || '(unknown)'}

## How to act on this host
Grok exposes the bridge's tools as \`devterm__*\` (the MCP server is named
\`devterm\`). Use them — they run on THIS host over the existing SSH connection.
Do not \`ssh\` elsewhere, do not try to use a local checkout, and do not use any
built-in shell or file tool (they are disabled in this session's config).
- \`devterm__run_command\` — run a shell command here.
- \`devterm__read_file\` / \`devterm__write_file\` / \`devterm__list_dir\` — files on this host.
- \`devterm__get_host_context\` — re-read these facts.
- \`devterm__ping\` — confirm the bridge is still alive.

The DevTerm MCP bridge is a real HTTP server on localhost; its bearer token is
in the \`.grok/config.toml\` Grok loaded. The bridge enforces the operator's
policy (read-only / confirm / full) before running any tool, and destructive
operations may prompt the operator for approval.

${workingDirSection(cwd)}
## Your working directory is a throwaway
The path you see on launch is a temp dir DevTerm uses only to hold the Grok
config and this briefing — it is **not** a checkout of the remote host. Anything
that looks like a local path is on your machine, not the host; use the
\`devterm__*\` tools for everything on the connected host.

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
 * Per-session AGENTS.md describing the host for the Codex TUI.
 *
 * Codex namespaces MCP tools as `mcp__devterm__<name>` (server `devterm`, tool
 * `run_command` → `mcp__devterm__run_command`). The launch step writes an
 * isolated `CODEX_HOME/config.toml` with the HTTP bridge entry and disables
 * built-in shell tools; this briefing steers the model toward the prefixed
 * tools for all host work.
 */
export function buildCodexMd(context: HostContext, airGapped: boolean, cwd?: string): string {
  const osName =
    context.os === 'windows'
      ? 'Windows'
      : context.os === 'mac'
        ? 'macOS'
        : context.os === 'linux'
          ? 'Linux'
          : 'unknown OS'

  return `# Connected host: ${context.hostname}

You are operating on a **remote ${osName}** host through DevTerm's MCP bridge.

- Host: \`${context.hostname}\`
- OS: ${osName}
- Details: ${context.detail || '(unknown)'}

## How to act on this host
Codex exposes the bridge's tools as \`mcp__devterm__*\` (the MCP server is named
\`devterm\`). Use them — they run on THIS host over the existing SSH connection.
Do not \`ssh\` elsewhere, do not try to use a local checkout, and do not use any
built-in shell or file tool (they are disabled in this session's config).
- \`mcp__devterm__run_command\` — run a shell command here.
- \`mcp__devterm__read_file\` / \`mcp__devterm__write_file\` / \`mcp__devterm__list_dir\` — files on this host.
- \`mcp__devterm__get_host_context\` — re-read these facts.
- \`mcp__devterm__ping\` — confirm the bridge is still alive.

The DevTerm MCP bridge is a real HTTP server on localhost; its bearer token is
in the Codex config this session loaded. The bridge enforces the operator's
policy (read-only / confirm / full) before running any tool, and destructive
operations may prompt the operator for approval.

${workingDirSection(cwd)}
## Your working directory is a throwaway
The path you see on launch is a temp dir DevTerm uses only to hold the Codex
config and this briefing — it is **not** a checkout of the remote host. Anything
that looks like a local path is on your machine, not the host; use the
\`mcp__devterm__*\` tools for everything on the connected host.

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
