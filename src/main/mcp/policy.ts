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
 * The longest-prefix match is computed by the host (see `approval-rules.ts`).
 */
export type RuleMatcher = (sessionId: string, command: string) => Promise<{ outcome: RuleOutcome } | undefined>

// Destructive operations are confirmed in "confirm" mode and allowed in "full".
const DESTRUCTIVE =
  /(\brm\s+-[a-z]*r|\bmkfs\b|\bdd\s+if=|:\(\)\s*\{|\bshutdown\b|\breboot\b|\bsystemctl\s+(stop|disable|mask)\b|\b(oc|kubectl)\s+delete\b|\bdrop\s+(database|table)\b|>\s*\/dev\/sd)/i

// Anything that mutates state is blocked outright on read-only hosts.
const MUTATING =
  /(\b(rm|mv|cp|touch|mkdir|rmdir|chmod|chown|ln|kill|pkill|tee)\b|>>?|\b(yum|dnf|apt|apt-get|pip|npm)\s+(install|remove|update|upgrade)|\bsystemctl\s+(start|restart|enable)|\b(oc|kubectl)\s+(apply|create|scale|edit|patch)|\bgit\s+(push|reset|clean)|\bnpm\s+publish)/i

/**
 * Per-host guardrail layer enforced at the MCP boundary. Read-only blocks
 * mutations, confirm asks for mutations/destructive commands, and full allows.
 *
 * An optional `ruleMatcher` lets the host inject approval rules (e.g. longest
 * prefix match against `approval-rules.json`) as a PRE-CHECK: an explicit
 * `allow` or `deny` rule short-circuits the verdict, and an `ask` rule
 * falls through to the mode-based decision (so the mode remains the
 * authoritative source of truth when no rule applies).
 */
export class Policy {
  constructor(
    public mode: PolicyMode = 'confirm',
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
    const destructive = DESTRUCTIVE.test(cmd)
    const mutating = MUTATING.test(cmd)
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
