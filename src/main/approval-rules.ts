// Foundation (cluster gate) — approval rules for the agent guardrail.
//
// Persisted to `userData/approval-rules.json` (atomic .tmp + rename so a
// crash can't corrupt the store — same pattern as snippets/workspaces).
// No secrets are stored here; the rules are plain command-prefix tokens + an
// outcome (allow / deny / ask), optionally scoped to a session id.
//
// `match()` is a longest-prefix match: the prefix is treated as a literal
// token, and matches at a token boundary at the end of the command. So
// `kubectl` matches `kubectl get pods` and `kubectl` itself, but NOT
// `kubectlized` (the next char after the prefix is whitespace, semicolon,
// `|`, `&`, or end-of-string).

import { app } from 'electron'
import { randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import { join } from 'path'
import type { ApprovalRule } from '@shared/types'

const storeFile = () => join(app.getPath('userData'), 'approval-rules.json')

/** In-memory cache so match() doesn't re-read disk on every run_command. */
let cached: ApprovalRule[] | null = null
/** Serialize read-modify-write mutations so concurrent add/remove can't lose rules. */
let writeChain: Promise<void> = Promise.resolve()

async function readAll(): Promise<ApprovalRule[]> {
  if (cached) return cached
  try {
    const raw = await fs.readFile(storeFile(), 'utf8')
    const parsed = JSON.parse(raw)
    cached = Array.isArray(parsed?.rules) ? (parsed.rules as ApprovalRule[]) : []
  } catch {
    cached = [] // missing or unreadable file → no rules
  }
  return cached
}

async function writeAll(rules: ApprovalRule[]): Promise<void> {
  cached = rules
  const tmp = storeFile() + '.tmp'
  await fs.writeFile(tmp, JSON.stringify({ version: 1, rules }, null, 2), 'utf8')
  await fs.rename(tmp, storeFile()) // atomic replace so a crash mid-write can't corrupt the store
}

function enqueueWrite(mutate: (all: ApprovalRule[]) => ApprovalRule[] | Promise<ApprovalRule[]>): Promise<void> {
  const run = writeChain.then(async () => {
    const all = await readAll()
    const next = await mutate(all.slice())
    await writeAll(next)
  })
  // Keep the chain alive after failures so later writes aren't stuck.
  writeChain = run.catch(() => {
    /* ignore */
  })
  return run
}

export async function list(sessionId?: string): Promise<ApprovalRule[]> {
  const all = await readAll()
  if (sessionId == null) return all
  // Session-scoped rules are listed alongside global rules (sessionId undefined),
  // since both are candidates for `match()` on this session. The renderer can
  // filter further if it wants a strict "this session only" view.
  return all.filter((r) => r.sessionId === sessionId || r.sessionId == null)
}

export async function add(rule: Omit<ApprovalRule, 'id' | 'createdAt'>): Promise<ApprovalRule> {
  const entry: ApprovalRule = { ...rule, id: randomUUID(), createdAt: Date.now() }
  await enqueueWrite((all) => {
    all.push(entry)
    return all
  })
  return entry
}

export async function remove(id: string): Promise<void> {
  await enqueueWrite((all) => {
    const next = all.filter((r) => r.id !== id)
    return next.length === all.length ? all : next
  })
}

/**
 * Longest-prefix match. Returns the most specific (longest) rule whose
 * `commandPrefix` is a token-aligned prefix of the trimmed `command`. A
 * session-specific rule beats a global rule of the same length, but a longer
 * global rule still beats a shorter session-specific one (specificity = length).
 */
export async function match(sessionId: string, command: string): Promise<ApprovalRule | undefined> {
  const all = await readAll()
  return matchRules(all, sessionId, command)
}

/**
 * Pure, side-effect-free longest-prefix match. Exported for unit tests so
 * the matching rules can be verified without loading the on-disk store
 * (which requires Electron's `app` module).
 *
 * Specificity = `commandPrefix.length`. A longer global rule beats a
 * shorter session-specific one. A session-specific rule beats a global rule
 * of the same length. Session rules only match their session; global rules
 * match anywhere.
 *
 * The prefix must end at a token boundary (whitespace, `|`, `&`, `;`,
 * `>`, `<`, `(`, or end-of-string) so `kubectl` matches `kubectl get pods`
 * but NOT `kubectlized`.
 */
export function matchRules(
  rules: ApprovalRule[],
  sessionId: string,
  command: string
): ApprovalRule | undefined {
  const cmd = command.trimStart()
  if (cmd.length === 0) return undefined
  let best: ApprovalRule | undefined
  for (const r of rules) {
    // Session rules only match their session; global rules match anywhere.
    if (r.sessionId != null && r.sessionId !== sessionId) continue
    if (cmd.length < r.commandPrefix.length) continue
    if (!cmd.startsWith(r.commandPrefix)) continue
    // Token boundary at the end of the prefix: next char (if any) must be
    // whitespace or a shell separator. End-of-string is also fine.
    const next = cmd.charCodeAt(r.commandPrefix.length)
    const isBoundary =
      r.commandPrefix.length === cmd.length ||
      next === 0x20 /* space */ ||
      next === 0x09 /* tab */ ||
      next === 0x0a /* \n */ ||
      next === 0x7c /* | */ ||
      next === 0x26 /* & */ ||
      next === 0x3b /* ; */ ||
      next === 0x3e /* > */ ||
      next === 0x3c /* < */ ||
      next === 0x28 /* ( */
    if (!isBoundary) continue
    if (!best || r.commandPrefix.length > best.commandPrefix.length) {
      best = r
    } else if (
      r.commandPrefix.length === best.commandPrefix.length &&
      r.sessionId === sessionId &&
      best.sessionId == null
    ) {
      best = r
    }
  }
  return best
}
