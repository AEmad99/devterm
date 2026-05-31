import type { HostContext } from '@shared/types'

/**
 * Per-session CLAUDE.md describing the host so the agent steers itself —
 * crucially, the air-gapped/local-mirror rules so it never proposes internet
 * installs on disconnected fleet hosts (§2.3).
 */
export function buildClaudeMd(context: HostContext, airGapped: boolean): string {
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
- \`run_command\` — run a shell command here.
- \`read_file\` / \`write_file\` / \`list_dir\` — files on this host.
- \`get_host_context\` — re-read these facts.

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
