export type PolicyMode = 'read_only' | 'confirm' | 'full'

export interface PolicyVerdict {
  allow: boolean
  needConfirm: boolean
  reason?: string
}

// Destructive operations force a confirmation regardless of mode (§7.2).
const DESTRUCTIVE =
  /(\brm\s+-[a-z]*r|\bmkfs\b|\bdd\s+if=|:\(\)\s*\{|\bshutdown\b|\breboot\b|\bsystemctl\s+(stop|disable|mask)\b|\b(oc|kubectl)\s+delete\b|\bdrop\s+(database|table)\b|>\s*\/dev\/sd)/i

// Anything that mutates state — blocked outright on read-only hosts.
const MUTATING =
  /(\b(rm|mv|cp|touch|mkdir|rmdir|chmod|chown|ln|kill|pkill|tee)\b|>>?|\b(yum|dnf|apt|apt-get|pip|npm)\s+(install|remove|update|upgrade)|\bsystemctl\s+(start|restart|enable)|\b(oc|kubectl)\s+(apply|create|scale|edit|patch)|\bgit\s+(push|reset|clean)|\bnpm\s+publish)/i

/**
 * Per-host guardrail layer enforced at the MCP boundary — the whole point of
 * routing the agent through the bridge rather than letting it `ssh host "..."`.
 */
export class Policy {
  constructor(public mode: PolicyMode = 'confirm') {}

  evaluateCommand(cmd: string): PolicyVerdict {
    const destructive = DESTRUCTIVE.test(cmd)
    if (this.mode === 'read_only') {
      if (destructive || MUTATING.test(cmd))
        return { allow: false, needConfirm: false, reason: 'host is read-only' }
      return { allow: true, needConfirm: false }
    }
    if (this.mode === 'confirm') return { allow: true, needConfirm: true }
    // full (lab only): still force confirmation on clearly destructive ops.
    return { allow: true, needConfirm: destructive }
  }

  evaluateWrite(): PolicyVerdict {
    if (this.mode === 'read_only') return { allow: false, needConfirm: false, reason: 'host is read-only' }
    if (this.mode === 'confirm') return { allow: true, needConfirm: true }
    return { allow: true, needConfirm: false }
  }
}
