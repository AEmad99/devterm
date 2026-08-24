import { useSessions } from '../store/sessions'
import { DEFAULT_GROUP, useLayout } from '../store/layout'
import type { BrowserOpenRequest } from '@shared/types'

/**
 * Renderer half of agent browser control.
 *
 * - `initBrowserControl()` subscribes once to main's open requests and turns
 *   them into either "add a tab to the agent's existing pane" or "create a
 *   fresh agent-owned pane whose first tab uses the pre-agreed tabKey".
 * - Panes register an opener here so a request can extend them imperatively,
 *   mirroring how registerBrowserGuest routes guest popups back to panes.
 * - Per-tab lifecycle reports (register/update/unregister) are thin wrappers
 *   over the preload bridge; BrowserTab calls them from its webview events.
 */

type PaneOpener = (tabKey: string, url: string) => void

const openers = new Map<string, PaneOpener>()
/** tabKey → close fn, so main's browser_close tool can destroy the right tab. */
const closers = new Map<string, () => void>()

export function registerPaneOpener(paneSessionId: string, open: PaneOpener): () => void {
  openers.set(paneSessionId, open)
  return () => {
    if (openers.get(paneSessionId) === open) openers.delete(paneSessionId)
  }
}

export function registerTabCloser(tabKey: string, close: () => void): () => void {
  closers.set(tabKey, close)
  return () => {
    if (closers.get(tabKey) === close) closers.delete(tabKey)
  }
}

function handleOpenRequest(req: BrowserOpenRequest): void {
  const { sessions } = useSessions.getState()
  // Prefer extending the agent's most recent living pane…
  const owned = sessions.filter(
    (x) => x.kind === 'browser' && x.agentOwnedBy === req.ownerAgentSessionId && !x.closed
  )
  for (let i = owned.length - 1; i >= 0; i--) {
    const opener = openers.get(owned[i].id)
    if (opener) {
      opener(req.tabKey, req.url)
      return
    }
  }
  // …otherwise spawn a dedicated agent-owned pane. Place it in the calling
  // session's group when we can find one, else the request's group hint,
  // else the active group.
  const caller = sessions.find((x) => x.id === req.ownerAgentSessionId)
  const groupId = caller?.groupId ?? req.groupId ?? DEFAULT_GROUP
  const paneId = useSessions.getState().addBrowser({
    url: req.url,
    groupId,
    agentOwnedBy: req.ownerAgentSessionId,
    firstTabKey: req.tabKey
  })
  // Layout.sync normally waits for a React effect. Do it now so the new pane
  // is in the tree before we split — otherwise the webview mounts off-screen
  // (`.term-hidden`) and Chromium may never fire `dom-ready`, which makes
  // browser_open time out.
  const live = useSessions.getState().sessions
  const layout = useLayout.getState()
  layout.sync(live.map((s) => ({ id: s.id, groupId: s.groupId })))
  if (caller) layout.splitBeside(caller.id, paneId, 'right')
}

let wired = false

export function initBrowserControl(): void {
  if (wired) return
  wired = true
  window.devterm.browserControl.onRequest(handleOpenRequest)
  window.devterm.browserControl.onCloseTab((tabKey) => {
    closers.get(tabKey)?.()
  })
}

export function reportTabRegistered(args: {
  paneSessionId: string
  tabKey: string
  wcId: number
  url: string
  title: string
  agentOwned: boolean
  ownerAgentSessionId?: string
}): void {
  void window.devterm.browserControl.register({ ...args }).catch(() => undefined)
}

export function reportTabUnregistered(tabKey: string): void {
  window.devterm.browserControl.unregister(tabKey)
}

export function reportTabUrl(tabKey: string, url: string): void {
  if (!url) return
  window.devterm.browserControl.update(tabKey, { url })
}

export function reportTabTitle(tabKey: string, title: string): void {
  if (!title) return
  window.devterm.browserControl.update(tabKey, { title })
}
