import type { HostContext } from '@shared/types'

/**
 * Per-session AGENTS.md describing the host so the agent steers itself —
 * crucially, the air-gapped/local-mirror rules so it never proposes internet
 * installs on disconnected fleet hosts (§2.3).
 *
 * pi auto-loads AGENTS.md from the cwd at startup, so the launch step writes
 * this file into the per-session temp directory.
 */
export function buildAgentsMd(context: HostContext, airGapped: boolean): string {
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
