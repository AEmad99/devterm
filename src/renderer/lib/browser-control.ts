import { useSessions } from '../store/sessions'
import { allLeaves, DEFAULT_GROUP, useLayout } from '../store/layout'
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
/** tabKey → focus/activate fn for browser_focus. */
const focusers = new Map<string, () => void>()

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

/**
 * Make an agent browser tab the selected tab of its own pane when that pane
 * is not also holding a terminal. Does not change the operator's group,
 * focus mode, or which terminal they are working in — those switches were
 * sending people to a shell they had not opened.
 */
export function revealBrowserPane(sessionId: string): void {
  const sessions = useSessions.getState().sessions
  if (!sessions.some((session) => session.id === sessionId && !session.closed)) return
  for (const group of useLayout.getState().groups) {
    const leaf = allLeaves(group.root).find((item) => item.tabs.includes(sessionId))
    if (!leaf) continue
    if (leaf.active === sessionId) return
    const hidesTerminal = leaf.tabs.some((id) => {
      if (id === sessionId) return false
      const other = sessions.find((session) => session.id === id)
      return !!other && other.kind !== 'browser'
    })
    if (!hidesTerminal) useLayout.getState().setLeafActiveTab(leaf.id, sessionId)
    return
  }
}

export function registerTabFocuser(tabKey: string, focus: () => void): () => void {
  focusers.set(tabKey, focus)
  return () => {
    if (focusers.get(tabKey) === focus) focusers.delete(tabKey)
  }
}

interface OperatorFocus {
  activeId: string | null
  activeGroupId: string
  focusedId: string | null
  activeLeaves: Map<string, string | null>
  leafActives: Array<{ leafId: string; active: string | null }>
}

function snapshotOperatorFocus(): OperatorFocus {
  const layout = useLayout.getState()
  const leafActives: OperatorFocus['leafActives'] = []
  const activeLeaves = new Map<string, string | null>()
  for (const group of layout.groups) {
    activeLeaves.set(group.id, group.activeLeaf)
    for (const leaf of allLeaves(group.root)) {
      leafActives.push({ leafId: leaf.id, active: leaf.active })
    }
  }
  return {
    activeId: useSessions.getState().activeId,
    activeGroupId: layout.activeGroupId,
    focusedId: layout.focusedId,
    activeLeaves,
    leafActives
  }
}

function restoreOperatorFocus(saved: OperatorFocus): void {
  useLayout.setState((state) => ({
    activeGroupId: state.groups.some((g) => g.id === saved.activeGroupId)
      ? saved.activeGroupId
      : state.activeGroupId,
    focusedId: saved.focusedId,
    groups: state.groups.map((group) => {
      const leafId = saved.activeLeaves.get(group.id)
      if (leafId == null || group.activeLeaf === leafId) return group
      const live = new Set(allLeaves(group.root).map((leaf) => leaf.id))
      if (!live.has(leafId)) return group
      return { ...group, activeLeaf: leafId }
    })
  }))
  const current = useSessions.getState().activeId
  if (!saved.activeId || current === saved.activeId) return
  if (useSessions.getState().sessions.some((session) => session.id === saved.activeId)) {
    useSessions.getState().setActive(saved.activeId)
  }
}

/**
 * Open an agent-owned browser beside the calling session.
 * The operator's active terminal, group, and focus mode stay where they were.
 * Parking the new id on the active leaf first (layout sync) used to mark it
 * active and, once it was split back out, reveal whichever tab was last.
 */
export function placeAgentBrowser(req: BrowserOpenRequest): void {
  const sessions = useSessions.getState().sessions
  const owned = sessions.filter(
    (session) =>
      session.kind === 'browser' &&
      session.agentOwnedBy === req.ownerAgentSessionId &&
      !session.closed
  )
  for (let i = owned.length - 1; i >= 0; i--) {
    const opener = openers.get(owned[i].id)
    if (opener) {
      opener(req.tabKey, req.url)
      return
    }
  }

  const saved = snapshotOperatorFocus()
  const caller = sessions.find((session) => session.id === req.ownerAgentSessionId)
  const layout = useLayout.getState()
  const callerGroup = caller
    ? layout.groups.find((group) =>
        allLeaves(group.root).some((leaf) => leaf.tabs.includes(caller.id))
      )
    : undefined
  const groupId =
    callerGroup?.id ?? caller?.groupId ?? req.groupId ?? layout.activeGroupId ?? DEFAULT_GROUP
  const paneId = useSessions.getState().addBrowser({
    url: req.url,
    groupId,
    agentOwnedBy: req.ownerAgentSessionId,
    firstTabKey: req.tabKey,
    activate: false
  })
  const place = () =>
    caller ? useLayout.getState().splitNewBeside(caller.id, paneId, 'right') : false
  if (!place()) {
    // The anchor is not in a tree yet. Sync would append the browser onto
    // whatever leaf is active and select it; put the previous tabs back
    // before splitting so that selection does not stick.
    useLayout.getState().sync(
      useSessions.getState().sessions.map((session) => ({
        id: session.id,
        groupId: session.groupId
      }))
    )
    for (const row of saved.leafActives) {
      if (row.active) useLayout.getState().setLeafActiveTab(row.leafId, row.active)
    }
    place()
  }
  restoreOperatorFocus(saved)
}

function handleOpenRequest(req: BrowserOpenRequest): void {
  placeAgentBrowser(req)
}

let wired = false

export function initBrowserControl(): void {
  if (wired) return
  wired = true
  window.devterm.browserControl.onRequest(handleOpenRequest)
  window.devterm.browserControl.onCloseTab((tabKey) => {
    closers.get(tabKey)?.()
  })
  window.devterm.browserControl.onFocusTab((tabKey) => {
    focusers.get(tabKey)?.()
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
