/**
 * Shared navigation guards for in-app browser guests.
 *
 * Single source of truth for "may this URL be loaded into a browser pane?"
 * Both the app-level `will-navigate` hardening in src/main/index.ts AND the
 * MCP `browser_*` tools route through these helpers, so an agent can never
 * reach a scheme the interactive pane couldn't (a main-process `loadURL`
 * bypasses guest navigation events, which is exactly why the tools must
 * re-check here before calling it).
 */

/** http(s) or about:blank — the only things a browser pane may load. */
export function guestUrlOk(url: string): boolean {
  return /^https?:\/\//i.test(url) || url === 'about:blank'
}

/** Normalize bare input into a loadable URL; null when it can't be made safe. */
export function toLoadableUrl(raw: string): string | null {
  const s = (raw ?? '').trim()
  if (!s) return null
  if (s === 'about:blank') return s
  // Explicit scheme+authority: keep for the guest guard to judge (it accepts
  // http(s), rejects everything else).
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return s
  if (/^https?:/i.test(s)) return s
  // No scheme at all. NOTE: `localhost:3000` looks like a scheme to a naive
  // regex (`localhost:` + port digits), so we require a strict authority/path
  // charset before prefixing http — anything else (javascript:, data:, spaces)
  // is refused rather than laundered into a plausible-looking http URL.
  if (!/^[a-zA-Z0-9._\-:[\]%/]+$/.test(s)) return null
  return `http://${s}`
}

/**
 * May this URL be handed to the OS browser? Mirrors the allowlist in
 * registerBrowserIpc's open-external handler.
 */
export function externalUrlOk(url: string): boolean {
  try {
    const { protocol } = new URL(url)
    return protocol === 'http:' || protocol === 'https:' || protocol === 'mailto:'
  } catch {
    return false
  }
}
