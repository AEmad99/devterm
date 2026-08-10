/**
 * Minimal OpenSSH config parser for importing concrete Host entries into
 * DevTerm saved connections. Not a full OpenSSH implementation — enough to
 * pull HostName / User / Port / IdentityFile / ProxyJump from typical configs.
 */

export interface ParsedSshHost {
  /** First non-wildcard Host pattern (display name). */
  alias: string
  host: string
  port: number
  username?: string
  privateKeyPath?: string
  jump?: { host: string; port: number; username?: string }
}

interface HostBlock {
  patterns: string[]
  opts: Record<string, string>
}

function stripComment(line: string): string {
  // OpenSSH comments start with # outside of quotes; keep it simple.
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === "'" && !inDouble) inSingle = !inSingle
    else if (c === '"' && !inSingle) inDouble = !inDouble
    else if (c === '#' && !inSingle && !inDouble) return line.slice(0, i)
  }
  return line
}

function splitKw(line: string): { key: string; value: string } | null {
  const t = stripComment(line).trim()
  if (!t) return null
  // Keyword + value: space or = separator.
  const m = t.match(/^([A-Za-z][\w-]*)(?:\s*=\s*|\s+)(.+)$/)
  if (!m) return null
  return { key: m[1].toLowerCase(), value: m[2].trim().replace(/^["']|["']$/g, '') }
}

function isWildcardPattern(p: string): boolean {
  return p.includes('*') || p.includes('?') || p.includes('!')
}

/** Parse a ProxyJump value: user@host:port or host:port or [user@]host. */
export function parseProxyJump(raw: string): { host: string; port: number; username?: string } | null {
  const s = raw.split(',')[0]?.trim() // first hop only
  if (!s) return null
  // user@host:port | user@host | host:port | host
  const m = s.match(/^(?:([^@[\]]+)@)?(\[[^\]]+\]|[^:]+)(?::(\d+))?$/)
  if (!m) return null
  const host = (m[2] ?? '').replace(/^\[|\]$/g, '')
  if (!host) return null
  const port = m[3] ? Number(m[3]) : 22
  if (!Number.isFinite(port) || port <= 0) return null
  return { host, port, username: m[1] || undefined }
}

/**
 * Parse OpenSSH config text into concrete Host entries.
 * Host * (and other wildcard-only blocks) supply defaults; they are not
 * imported as connections. Multi-pattern Host lines with a concrete name
 * still produce an entry using the first non-wildcard pattern as the alias.
 */
export function parseSshConfig(text: string): ParsedSshHost[] {
  const blocks: HostBlock[] = []
  let current: HostBlock | null = null

  for (const rawLine of text.split(/\r?\n/)) {
    const kw = splitKw(rawLine)
    if (!kw) continue
    if (kw.key === 'host') {
      if (current) blocks.push(current)
      current = {
        patterns: kw.value.split(/\s+/).filter(Boolean),
        opts: {}
      }
      continue
    }
    if (current) {
      // First value wins within a block (OpenSSH "first obtained" for a match;
      // within a single Host stanza last-write is common in hand-edited files —
      // we keep first so explicit lines before repeats win).
      if (current.opts[kw.key] === undefined) current.opts[kw.key] = kw.value
    }
  }
  if (current) blocks.push(current)

  // Collect global defaults from Host * / Host *.* style-only blocks.
  const globals: Record<string, string> = {}
  for (const b of blocks) {
    if (b.patterns.length > 0 && b.patterns.every(isWildcardPattern)) {
      for (const [k, v] of Object.entries(b.opts)) {
        if (globals[k] === undefined) globals[k] = v
      }
    }
  }

  const out: ParsedSshHost[] = []
  const seenAlias = new Set<string>()

  for (const b of blocks) {
    const concrete = b.patterns.filter((p) => !isWildcardPattern(p))
    if (!concrete.length) continue

    const opts = { ...globals, ...b.opts }
    for (const alias of concrete) {
      if (seenAlias.has(alias)) continue
      seenAlias.add(alias)

      const host = opts.hostname || alias
      const port = opts.port ? Number(opts.port) : 22
      if (!Number.isFinite(port) || port <= 0) continue

      const username = opts.user || opts.username || undefined
      const privateKeyPath = opts.identityfile || undefined
      let jump: ParsedSshHost['jump']
      if (opts.proxyjump) {
        jump = parseProxyJump(opts.proxyjump) ?? undefined
      } else if (opts.proxycommand) {
        // Too free-form to map safely — skip jump.
        jump = undefined
      }

      out.push({
        alias,
        host,
        port,
        username,
        privateKeyPath,
        jump
      })
    }
  }

  return out
}
