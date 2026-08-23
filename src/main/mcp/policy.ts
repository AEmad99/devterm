export type PolicyMode = 'read_only' | 'confirm' | 'full'

export interface PolicyVerdict {
  allow: boolean
  needConfirm: boolean
  reason?: string
}

export type RuleOutcome = 'allow' | 'deny' | 'ask'

/**
 * Optional rule matcher supplied by the host environment. Returns the matched
 * approval rule for `(sessionId, command)`, or undefined if no rule applies.
 * The longest-prefix match is computed by the host (see `agent/approval-rules.ts`).
 */
export type RuleMatcher = (
  sessionId: string,
  command: string
) => Promise<{ outcome: RuleOutcome } | undefined>

// Destructive operations are confirmed in "confirm" mode and allowed in "full".
// NOTE: this is a defense-in-depth denylist over a *cooperative* agent, not a
// hard sandbox — a determined model can obfuscate around any regex (base64,
// `$IFS`, env indirection). `full` is the only honestly-unrestricted mode; treat
// `read_only`/`confirm` as guardrails that catch the obvious cases. We match
// `rm -f` as well as `rm -r`, `dd of=` (the writing form), and add shred /
// find -delete / rsync --delete and more device nodes.
const DESTRUCTIVE =
  /(\brm\s+-[a-z]*[rf]|\bmkfs\b|\bdd\b[^|;&]*\bof=|\bshred\b|\bfind\b.*\s-delete\b|\brsync\b.*\s--delete\b|:\(\)\s*\{|\bshutdown\b|\breboot\b|\bsystemctl\s+(stop|disable|mask)\b|\b(oc|kubectl)\s+delete\b|\bdrop\s+(database|table)\b|>\s*\/dev\/(sd|nvme|hd|vd|mapper))/i

// Anything that mutates state is blocked outright on read-only hosts. Adds the
// in-place / truncating writers the old list missed (sed -i, truncate, unlink,
// chattr) so read-only actually blocks file modification, not just `rm`/`>`.
// The redirection alternation excludes digit/&-adjacent forms (`2>&1`, `>&2`,
// `2>file` fd duplication stays excluded only for `2>&1`-style targets) so
// stderr plumbing in an otherwise read-only command doesn't false-positive.
const MUTATING =
  /(\b(rm|mv|cp|touch|mkdir|rmdir|chmod|chown|chattr|ln|kill|pkill|tee|truncate|unlink)\b|\bsed\s+-i|(?<![0-9&])>>?(?!&)|\b(yum|dnf|apt|apt-get|pip|npm)\s+(install|remove|update|upgrade)|\bsystemctl\s+(start|restart|enable)|\b(oc|kubectl)\s+(apply|create|scale|edit|patch)|\bgit\s+(push|reset|clean)|\bnpm\s+publish)/i

/**
 * Strip single/double-quoted spans before pattern checks: a quoted `>` or a
 * keyword inside a literal string (e.g. `echo "a > b"`, `grep 'rm -rf' log`)
 * is not a mutation, and matching it blocked read-only commands.
 */
function stripQuoted(cmd: string): string {
  return cmd.replace(/'[^']*'|"[^"]*"/g, ' ')
}

/**
 * MCP-boundary guardrail. Session UI no longer picks a mode — launches use
 * `full` so the agent CLI owns permission prompts. `read_only` / `confirm`
 * remain implemented for Settings approval-rule `ask` fall-through and tests.
 *
 * An optional `ruleMatcher` lets the host inject approval rules (e.g. longest
 * prefix match against `approval-rules.json`) as a PRE-CHECK: an explicit
 * `allow` or `deny` rule short-circuits the verdict, and an `ask` rule
 * falls through to the mode-based decision.
 */
export class Policy {
  constructor(
    public mode: PolicyMode = 'full',
    private ruleMatcher?: RuleMatcher
  ) {}

  async evaluateCommandAsync(sessionId: string, cmd: string): Promise<PolicyVerdict> {
    // PRE-CHECK: explicit approval rules always win over mode for `allow` /
    // `deny` so a stored rule can't be silently bypassed by changing the
    // host's policy mode. `ask` is a no-op here — it just falls through
    // to the mode-based decision, which may itself ask.
    if (this.ruleMatcher) {
      const r = await this.ruleMatcher(sessionId, cmd)
      if (r?.outcome === 'allow') return { allow: true, needConfirm: false }
      if (r?.outcome === 'deny')
        return { allow: false, needConfirm: false, reason: 'denied by approval rule' }
    }
    return this.evaluateCommand(cmd)
  }

  evaluateCommand(cmd: string): PolicyVerdict {
    const scan = stripQuoted(cmd)
    const destructive = DESTRUCTIVE.test(scan)
    const mutating = MUTATING.test(scan)
    if (this.mode === 'read_only') {
      if (destructive || mutating)
        return { allow: false, needConfirm: false, reason: 'host is read-only' }
      return { allow: true, needConfirm: false }
    }
    if (this.mode === 'confirm') return { allow: true, needConfirm: destructive || mutating }
    return { allow: true, needConfirm: false }
  }

  evaluateWrite(): PolicyVerdict {
    if (this.mode === 'read_only')
      return { allow: false, needConfirm: false, reason: 'host is read-only' }
    if (this.mode === 'confirm') return { allow: true, needConfirm: true }
    return { allow: true, needConfirm: false }
  }
}
