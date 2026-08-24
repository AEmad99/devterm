import { webContents } from 'electron'
import type { BrowserControlTabInfo, BrowserOpenRequest } from '@shared/types'

/**
 * Registry of in-app browser tabs addressable by the MCP `browser_*` tools,
 * plus the per-agent access model:
 *
 *  - Agent-OWNED tabs (created via browser_open) are freely drivable by their
 *    owner agent.
 *  - USER tabs (panes the operator opened) require an explicit grant. The
 *    grant is requested by the tool layer (ConfirmActionModal), recorded here
 *    for the agent's lifetime, and cleared when the agent stops/closes.
 *
 * The renderer reports every tab's lifecycle over the browserControl:* IPC
 * channels (see ipc/browser-control.ts); this class owns no UI.
 */

export interface BrowserTabEntry {
  tabKey: string
  wcId: number
  paneSessionId: string
  url: string
  title: string
  agentOwned: boolean
}

export interface TabListing {
  tabKey: string
  title: string
  url: string
  kind: 'agent' | 'user'
  mine: boolean
  attachedByMe: boolean
}

const OPEN_WAIT_MS = 8000

export class BrowserControlService {
  /** wcId → entry (primary; guests are unique per live <webview>). */
  private byWc = new Map<number, BrowserTabEntry>()
  /** tabKey → wcId (model-facing handle). */
  private byKey = new Map<string, number>()
  /** agentSessionId → granted (user) tabKeys. */
  private grants = new Map<string, Set<string>>()
  /** agentSessionId → most recently opened owned tabKey (default target). */
  private lastOwned = new Map<string, string>()
  /** Pending browser_open requests waiting for the renderer to register. */
  private waiters = new Map<
    string,
    { resolve: (e: BrowserTabEntry) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }
  >()
  /** tabKey → owning agent session (agent-owned tabs only). */
  private owners = new Map<string, string>()

  constructor(private sendRequest: (req: BrowserOpenRequest) => void) {}

  // -- lifecycle (called from ipc/browser-control.ts) ------------------------

  register(info: BrowserControlTabInfo): void {
    if (!Number.isFinite(info.wcId)) return
    const prev = this.byKey.get(info.tabKey)
    if (prev !== undefined && prev !== info.wcId) this.byWc.delete(prev)
    this.byWc.delete(info.wcId)
    for (const [k, id] of this.byKey) if (id === info.wcId) this.byKey.delete(k)
    this.byKey.set(info.tabKey, info.wcId)
    this.byWc.set(info.wcId, {
      tabKey: info.tabKey,
      wcId: info.wcId,
      paneSessionId: info.paneSessionId,
      url: info.url,
      title: info.title,
      agentOwned: info.agentOwned
    })
    const waiter = this.waiters.get(info.tabKey)
    if (waiter) {
      clearTimeout(waiter.timer)
      this.waiters.delete(info.tabKey)
      waiter.resolve(this.byWc.get(info.wcId)!)
    }
    // Ownership travels with the registration payload so a pane remount
    // re-bonds to its agent without guesswork.
    if (info.agentOwned && info.ownerAgentSessionId)
      this.owners.set(info.tabKey, info.ownerAgentSessionId)
  }

  unregister(tabKey: string): void {
    const wcId = this.byKey.get(tabKey)
    if (wcId === undefined) return
    this.byKey.delete(tabKey)
    this.byWc.delete(wcId)
    this.owners.delete(tabKey)
    for (const set of this.grants.values()) set.delete(tabKey)
    for (const [sid, key] of this.lastOwned) if (key === tabKey) this.lastOwned.delete(sid)
  }

  updateMeta(tabKey: string, patch: { url?: string; title?: string }): void {
    const e = this.entry(tabKey)
    if (!e) return
    if (patch.url !== undefined) e.url = patch.url
    if (patch.title !== undefined) e.title = patch.title
  }

  // -- open ------------------------------------------------------------------

  /**
   * Ask the renderer to create an agent-owned pane+tab and wait for its
   * registration. The tabKey is generated here and travels with the request
   * so registration is deterministic (no polling heuristics).
   */
  async openTab(req: { url: string; groupId?: string; ownerAgentSessionId: string }): Promise<BrowserTabEntry> {
    const tabKey = `agt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const pending = new Promise<BrowserTabEntry>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(tabKey)
        reject(new Error('browser pane did not open in time (renderer unavailable?)'))
      }, OPEN_WAIT_MS)
      this.waiters.set(tabKey, { resolve, reject, timer })
    })
    try {
      this.sendRequest({
        tabKey,
        url: req.url,
        groupId: req.groupId,
        ownerAgentSessionId: req.ownerAgentSessionId
      })
      const entry = await pending
      this.markOwner(entry.tabKey, req.ownerAgentSessionId)
      this.lastOwned.set(req.ownerAgentSessionId, entry.tabKey)
      return entry
    } finally {
      const w = this.waiters.get(tabKey)
      if (w) {
        clearTimeout(w.timer)
        this.waiters.delete(tabKey)
      }
    }
  }

  // -- targeting & grants ----------------------------------------------------

  entry(tabKey: string): BrowserTabEntry | undefined {
    const wcId = this.byKey.get(tabKey)
    return wcId === undefined ? undefined : this.byWc.get(wcId)
  }

  /**
   * Resolve the tab a tool call targets. No tabKey → the agent's most recent
   * owned tab. A user tab requires a prior grant (browser_attach).
   */
  resolveTarget(
    agentSessionId: string,
    tabKey?: string
  ): { ok: true; entry: BrowserTabEntry } | { ok: false; err: string } {
    let key = tabKey
    if (!key) {
      key = this.lastOwned.get(agentSessionId)
      if (!key)
        return {
          ok: false,
          err: 'no open agent browser tab — call browser_open first, or pass an explicit tabId from browser_list'
        }
    }
    const e = this.entry(key)
    if (!e) return { ok: false, err: `tab ${key} does not exist (closed?)` }
    // Ownership check: only the creating agent drives its own tabs.
    const owner = this.ownerOf(e.tabKey)
    if (owner && owner !== agentSessionId)
      return { ok: false, err: 'that tab belongs to another agent session' }
    if (!this.hasAccess(agentSessionId, key))
      return {
        ok: false,
        err: `tab ${key} was opened by the operator — run browser_attach on it first`
      }
    return { ok: true, entry: e }
  }

  hasAccess(agentSessionId: string, tabKey: string): boolean {
    const e = this.entry(tabKey)
    if (!e) return false
    if (!e.agentOwned) return this.grants.get(agentSessionId)?.has(tabKey) ?? false
    return true
  }

  /** True when the target is a user tab that still needs its one-time confirm. */
  needsAttachConfirm(agentSessionId: string, tabKey: string): boolean {
    const e = this.entry(tabKey)
    return !!e && !e.agentOwned && !this.grants.get(agentSessionId)?.has(tabKey)
  }

  attach(agentSessionId: string, tabKey: string): void {
    let set = this.grants.get(agentSessionId)
    if (!set) this.grants.set(agentSessionId, (set = new Set()))
    set.add(tabKey)
  }

  detach(agentSessionId: string, tabKey: string): void {
    this.grants.get(agentSessionId)?.delete(tabKey)
  }

  list(agentSessionId: string): TabListing[] {
    const mine = this.grants.get(agentSessionId)
    const out: TabListing[] = []
    for (const e of this.byWc.values()) {
      out.push({
        tabKey: e.tabKey,
        title: e.title || '(untitled)',
        url: e.url,
        kind: e.agentOwned ? 'agent' : 'user',
        mine: e.agentOwned,
        attachedByMe: !!mine?.has(e.tabKey)
      })
    }
    return out
  }

  /** Clear grants + default-target bookkeeping when an agent stops or its session closes. */
  releaseAgent(agentSessionId: string): void {
    this.grants.delete(agentSessionId)
    this.lastOwned.delete(agentSessionId)
    for (const [key, owner] of this.owners) if (owner === agentSessionId) this.owners.delete(key)
  }

  markOwner(tabKey: string, agentSessionId: string): void {
    this.owners.set(tabKey, agentSessionId)
  }

  ownerOf(tabKey: string): string | undefined {
    return this.owners.get(tabKey)
  }

  /** Run a script inside the guest; clean error when the guest is gone. */
  async executeJs<T = unknown>(entry: BrowserTabEntry, script: string): Promise<T> {
    const wc = webContents.fromId(entry.wcId)
    if (!wc || wc.isDestroyed()) throw new Error('the tab\'s page is no longer running (was it closed?)')
    return (await wc.executeJavaScript(script, false)) as T
  }

  /** PNG bytes of the current viewport. */
  async capturePage(entry: BrowserTabEntry): Promise<Buffer> {
    const wc = webContents.fromId(entry.wcId)
    if (!wc || wc.isDestroyed()) throw new Error('the tab\'s page is no longer running (was it closed?)')
    const image = await wc.capturePage()
    return image.toPNG()
  }

  /**
   * Best-effort settle: wait until readyState==='complete' plus two rAFs so
   * post-load paints land, capped at `timeoutMs`. Returns what actually
   * happened so tools can tell the model "page may still be loading".
   */
  async waitForSettle(
    entry: BrowserTabEntry,
    timeoutMs = 8000
  ): Promise<'settled' | 'timeout'> {
    const wc = webContents.fromId(entry.wcId)
    if (!wc || wc.isDestroyed()) throw new Error('the tab\'s page is no longer running (was it closed?)')
    const script = `(function(){return new Promise(function(res){
var n=0;function done(){if(++n>=2)res('s')}
function raf(){requestAnimationFrame(done)}
if(document.readyState==='complete'){raf();raf()}else{
window.addEventListener('load',function(){raf();raf()},{once:true});
setTimeout(function(){res(document.readyState)},${Math.max(0, timeoutMs - 500)})}
setTimeout(function(){res('t')},${timeoutMs})})})()`
    try {
      const r = (await wc.executeJavaScript(script, false)) as string
      return r === 'timeout' || r === 't' ? 'timeout' : 'settled'
    } catch {
      return 'timeout'
    }
  }
}
