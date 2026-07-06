// Pure helpers for snippet placeholder substitution. A snippet command may
// contain {{token}} placeholders (e.g. `ssh {{user}}@{{host}}`); these are
// collected and prompted for before the command is sent to a terminal.
//
// This module also owns a *session-only* (sessionStorage) cache of recent
// placeholder values, scoped per (snippetId, placeholderName) pair. The cache
// is intentionally NOT localStorage and NOT persisted to disk: placeholder
// values often contain host names, usernames, and other identifying strings
// that a user would not want left behind when the window closes. sessionStorage
// is cleared automatically by the browser when the tab is closed.

const TOKEN = /\{\{\s*([\w.-]+)\s*\}\}/g

/** Unique placeholder names in `command`, in first-seen order. */
export function extractPlaceholders(command: string): string[] {
  const seen: string[] = []
  for (const m of command.matchAll(TOKEN)) {
    if (!seen.includes(m[1])) seen.push(m[1])
  }
  return seen
}

/** Substitute placeholder values into `command`; unfilled tokens are left as-is. */
export function applyPlaceholders(command: string, values: Record<string, string>): string {
  return command.replace(TOKEN, (whole, name) =>
    Object.prototype.hasOwnProperty.call(values, name) ? values[name] : whole
  )
}

// ---------------------------------------------------------------------------
// Recent-values cache
// ---------------------------------------------------------------------------

/** How long a cached value survives before it expires. */
export const PLACEHOLDER_CACHE_TTL_MS = 5 * 60 * 1000

const CACHE_PREFIX = 'devterm.placeholder.v1.'
const CACHE_INDEX_KEY = 'devterm.placeholder.v1.__index__'

interface CacheEntry {
  /** Stored value (the placeholder text the user last typed). */
  v: string
  /** Wall-clock ms at which the entry was written. */
  t: number
}

/**
 * Read the cached value for `(snippetId, placeholderName)`, or `undefined` if
 * the entry is missing or expired. Empty-string values are still returned (a
 * user who explicitly cleared a field probably wants that remembered too).
 *
 * `storage` is parameterised so tests can inject a fake; in production it
 * resolves to `window.sessionStorage`.
 */
export function getCachedPlaceholder(
  snippetId: string,
  placeholderName: string,
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null = safeSessionStorage()
): string | undefined {
  if (!storage) return undefined
  const key = cacheKey(snippetId, placeholderName)
  try {
    const raw = storage.getItem(key)
    if (!raw) return undefined
    const parsed = JSON.parse(raw) as CacheEntry
    if (
      !parsed ||
      typeof parsed.v !== 'string' ||
      typeof parsed.t !== 'number' ||
      Date.now() - parsed.t > PLACEHOLDER_CACHE_TTL_MS
    ) {
      // Expired — drop it lazily so the storage doesn't grow without bound.
      try {
        storage.removeItem(key)
      } catch {
        /* ignore */
      }
      return undefined
    }
    return parsed.v
  } catch {
    return undefined
  }
}

/**
 * Cache `value` for `(snippetId, placeholderName)`, stamping it with the
 * current time. The call is a no-op when storage is unavailable (e.g. SSR,
 * locked-down environment).
 */
export function setCachedPlaceholder(
  snippetId: string,
  placeholderName: string,
  value: string,
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null = safeSessionStorage()
): void {
  if (!storage) return
  const key = cacheKey(snippetId, placeholderName)
  const entry: CacheEntry = { v: value, t: Date.now() }
  try {
    storage.setItem(key, JSON.stringify(entry))
    // Maintain a tiny index of known keys so `clearCachedPlaceholders` can
    // wipe the lot without scanning every `devterm.placeholder.v1.` prefix
    // (some platforms are slow at full-key iteration).
    const indexRaw = storage.getItem(CACHE_INDEX_KEY)
    const index = new Set<string>(indexRaw ? (JSON.parse(indexRaw) as string[]) : [])
    index.add(key)
    storage.setItem(CACHE_INDEX_KEY, JSON.stringify(Array.from(index)))
  } catch {
    /* quota / privacy mode — the user simply won't get pre-fills next time. */
  }
}

/**
 * Erase every cached placeholder value across every snippet. Called from the
 * "Clear recent values" button on the palette's parameter form.
 */
export function clearCachedPlaceholders(
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null = safeSessionStorage()
): number {
  if (!storage) return 0
  let removed = 0
  try {
    const raw = storage.getItem(CACHE_INDEX_KEY)
    const keys: string[] = raw ? (JSON.parse(raw) as string[]) : []
    for (const k of keys) {
      try {
        storage.removeItem(k)
        removed++
      } catch {
        /* ignore individual failures */
      }
    }
    storage.removeItem(CACHE_INDEX_KEY)
  } catch {
    /* ignore */
  }
  return removed
}

/**
 * Build a pre-filled `Record<name, value>` for every placeholder in `command`
 * using the per-snippet cache. Missing or expired entries simply don't appear
 * in the result — the caller treats absent keys as "no pre-fill".
 */
export function prefilledValues(
  snippetId: string,
  command: string,
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null = safeSessionStorage()
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of extractPlaceholders(command)) {
    const v = getCachedPlaceholder(snippetId, name, storage)
    if (v !== undefined) out[name] = v
  }
  return out
}

/**
 * Persist every value in `values` whose placeholder name appears in
 * `command`. Values that are not placeholder names in the command are ignored
 * (defensive — callers shouldn't pass extras, but a stray entry shouldn't blow
 * up the storage).
 */
export function persistValues(
  snippetId: string,
  command: string,
  values: Record<string, string>,
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null = safeSessionStorage()
): void {
  const names = new Set(extractPlaceholders(command))
  for (const [name, value] of Object.entries(values)) {
    if (!names.has(name)) continue
    setCachedPlaceholder(snippetId, name, value ?? '', storage)
  }
}

function cacheKey(snippetId: string, placeholderName: string): string {
  return `${CACHE_PREFIX}${snippetId}::${placeholderName}`
}

/** `window.sessionStorage` if available, else null. Wrapped so SSR / tests can override. */
function safeSessionStorage(): Storage | null {
  try {
    if (typeof window === 'undefined') return null
    return window.sessionStorage
  } catch {
    return null
  }
}
