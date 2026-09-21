import type {
  SavedConnection,
  SSHProfile,
  SessionRestoreAuthMethod,
  SessionRestoreBrowserTab,
  SessionRestoreEditor,
  SessionRestoreGroup,
  SessionRestoreItem,
  SessionRestoreSshDraft,
  SessionRestoreSnapshot,
  WorkspaceLayoutNode
} from '@shared/types'
import { useLayout, DEFAULT_GROUP, groupActiveSession, type LayoutNode } from '../store/layout'
import { useSessions, type Session } from '../store/sessions'
import { useEditors } from '../store/editors'
import { useSettings } from '../store/settings'
import { toLiveSnapshot } from './workspace'
import { setAgentUiMode } from './agent-ui'
import { waitForRemoteConnectStagger } from './remote-connect'
import { encodeJump, listJumpHops } from '@shared/ssh-jump'
import type { SessionRestoreSshHop } from '@shared/types'

function restoreJumpList(
  jump: SessionRestoreSshHop | SessionRestoreSshHop[] | undefined
): SessionRestoreSshHop[] {
  if (!jump) return []
  return Array.isArray(jump) ? jump : [jump]
}

const newItemId = () => `sr-${crypto.randomUUID()}`

function hopUsesAgent(profile: {
  useAgent?: boolean
  password?: string
  privateKeyPath?: string
}): boolean {
  if (profile.useAgent === true) return true
  if (profile.useAgent === false) return false
  return !profile.password && !profile.privateKeyPath
}

function authMethodFor(profile: SSHProfile): SessionRestoreAuthMethod {
  if (profile.password) return 'password'
  if (profile.privateKeyPath) return 'key'
  if (hopUsesAgent(profile)) return 'agent'
  return 'none'
}

function sshDraftFor(profile: SSHProfile, secretId?: string): SessionRestoreSshDraft {
  const hop = {
    host: profile.host,
    port: profile.port,
    username: profile.username,
    authMethod: authMethodFor(profile),
    privateKeyPath: profile.privateKeyPath,
    hasPassphrase: !!profile.passphrase,
    useAgent: hopUsesAgent(profile)
  }
  return {
    ...hop,
    secretId,
    restoreSecret: {
      password: profile.password,
      passphrase: profile.passphrase,
      jumpPassword: listJumpHops(profile.jump)[0]?.password,
      jumpPassphrase: listJumpHops(profile.jump)[0]?.passphrase,
      jumpSecrets: listJumpHops(profile.jump).map((h) => ({
        password: h.password,
        passphrase: h.passphrase
      }))
    },
    jump: (() => {
      const hops = listJumpHops(profile.jump)
      if (!hops.length) return undefined
      const mapped: SessionRestoreSshHop[] = hops.map((h) => ({
        host: h.host,
        port: h.port,
        username: h.username,
        authMethod: authMethodFor(h),
        privateKeyPath: h.privateKeyPath,
        hasPassphrase: !!h.passphrase,
        useAgent: hopUsesAgent(h)
      }))
      return mapped.length === 1 ? mapped[0] : mapped
    })()
  }
}

function profileFromSshDraft(draft: SessionRestoreSshDraft): {
  profile: SSHProfile
  needsAuth: boolean
} {
  const secret = draft.restoreSecret
  const profile: SSHProfile = {
    host: draft.host,
    port: draft.port,
    username: draft.username,
    password: secret?.password,
    privateKeyPath: draft.privateKeyPath,
    passphrase: secret?.passphrase,
    useAgent: draft.useAgent ?? draft.authMethod === 'agent',
    jump: encodeJump(
      restoreJumpList(draft.jump).map((h, i) => {
        const hopSecret = secret?.jumpSecrets?.[i]
        const password = hopSecret?.password ?? (i === 0 ? secret?.jumpPassword : undefined)
        const passphrase = hopSecret?.passphrase ?? (i === 0 ? secret?.jumpPassphrase : undefined)
        return {
          host: h.host,
          port: h.port,
          username: h.username,
          password,
          privateKeyPath: h.privateKeyPath,
          passphrase,
          useAgent: h.useAgent ?? h.authMethod === 'agent'
        }
      })
    )
  }
  const primaryNeedsAuth =
    (draft.authMethod === 'password' && !secret?.password) ||
    (draft.authMethod === 'key' && !!draft.hasPassphrase && !secret?.passphrase) ||
    (draft.authMethod === 'none' && !draft.privateKeyPath && draft.useAgent !== true)
  const jumpNeedsAuth = restoreJumpList(draft.jump).some((h, i) => {
    const hopSecret = secret?.jumpSecrets?.[i]
    const password = hopSecret?.password ?? (i === 0 ? secret?.jumpPassword : undefined)
    const passphrase = hopSecret?.passphrase ?? (i === 0 ? secret?.jumpPassphrase : undefined)
    return (
      (h.authMethod === 'password' && !password) ||
      (h.authMethod === 'key' && !!h.hasPassphrase && !passphrase) ||
      (h.authMethod === 'none' && !h.privateKeyPath && h.useAgent !== true)
    )
  })
  return { profile, needsAuth: primaryNeedsAuth || jumpNeedsAuth }
}

function browserTabsFor(session: Session): SessionRestoreBrowserTab[] | undefined {
  const tabs = session.browserTabs
    ?.filter((tab) => tab.url.trim())
    .map((tab) => ({
      url: tab.url,
      title: tab.title,
      zoom: tab.zoom,
      muted: tab.muted
    }))
  return tabs?.length ? tabs : undefined
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs)
    void promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      }
    )
  })
}

function snapshotNode(
  n: LayoutNode | null,
  items: Map<string, string>
): WorkspaceLayoutNode | null {
  if (!n) return null
  if (n.type === 'leaf') {
    const tabs: string[] = []
    for (const sid of n.tabs) {
      const iid = items.get(sid)
      if (iid && !tabs.includes(iid)) tabs.push(iid)
    }
    if (!tabs.length) return null
    const active = (n.active && items.get(n.active)) || tabs[tabs.length - 1]
    return { type: 'leaf', tabs, active }
  }
  const kept: WorkspaceLayoutNode[] = []
  const keptSizes: number[] = []
  n.children.forEach((c, i) => {
    const r = snapshotNode(c, items)
    if (r) {
      kept.push(r)
      keptSizes.push(n.sizes[i] ?? 1)
    }
  })
  if (!kept.length) return null
  if (kept.length === 1) return kept[0]
  const total = keptSizes.reduce((a, b) => a + b, 0) || kept.length
  return { type: 'split', dir: n.dir, sizes: keptSizes.map((s) => s / total), children: kept }
}

/**
 * Sessions we can recreate after a restart: local shells, saved SSH
 * connections, ad-hoc SSH drafts, and browser panes (including every tab).
 */
export function restorableSessions(sessions: Session[], groupId: string): Session[] {
  return sessions.filter(
    (s) =>
      (s.groupId || DEFAULT_GROUP) === groupId &&
      !s.closed &&
      (!s.id.startsWith('pending-') || s.deferredRemote) &&
      (s.kind === 'local' ||
        s.kind === 'browser' ||
        (s.kind === 'remote' && (!!s.connectionId || !!s.restoreProfile)))
  )
}

/** Build a snapshot of every non-empty group for persistence. */
export function captureSessionRestoreSnapshot(
  sessions: Session[] = useSessions.getState().sessions
): SessionRestoreSnapshot | null {
  const layout = useLayout.getState()
  const groups: SessionRestoreGroup[] = []
  let activeGroupIndex = 0
  // session id → restore item id, across all groups (editors may reference any).
  const sidToItem = new Map<string, string>()

  for (const g of layout.groups) {
    const capturable = restorableSessions(sessions, g.id)
    if (!capturable.length) continue

    const items: SessionRestoreItem[] = capturable.map((s) => {
      const id = newItemId()
      sidToItem.set(s.id, id)
      return {
        id,
        kind: s.kind === 'remote' ? 'remote' : s.kind === 'browser' ? 'browser' : 'local',
        connectionId: s.kind === 'remote' ? s.connectionId : undefined,
        sshDraft:
          s.kind === 'remote' && !s.connectionId && s.restoreProfile
            ? sshDraftFor(s.restoreProfile, s.restoreSecretId)
            : undefined,
        cwd: s.cwd,
        title: s.customTitle ? s.title : undefined,
        url: s.kind === 'browser' ? s.url : undefined,
        browserTabs: s.kind === 'browser' ? browserTabsFor(s) : undefined,
        browserActiveTab: s.kind === 'browser' ? s.browserActiveTab : undefined,
        scrollback: s.restoreScrollback,
        liveSessionId: s.kind === 'local' || s.kind === 'remote' ? s.id : undefined,
        // Relaunch the agent when it was alive at snapshot time.
        agentKind: s.agentUiMode ? s.agentKind : undefined,
        agentUiMode: s.agentUiMode
      }
    })

    const root = g.root
    const layoutSnap = snapshotNode(root, sidToItem)
    if (g.id === layout.activeGroupId) activeGroupIndex = groups.length
    groups.push({
      name: g.name || 'Terminals',
      items,
      layout: layoutSnap
    })
  }

  if (!groups.length) return null

  // Open editor documents, referencing their owning remote item when possible.
  const editors: SessionRestoreEditor[] = useEditors
    .getState()
    .docs.filter((d) => d.state === 'ready' || d.state === 'loading')
    .map((d) => ({
      scope: d.scope,
      itemId: d.scope === 'remote' && d.sessionId ? sidToItem.get(d.sessionId) : undefined,
      path: d.path
    }))
    .filter((d) => d.scope === 'local' || !!d.itemId)
    .slice(0, 64)

  return {
    version: 1,
    savedAt: Date.now(),
    groups,
    activeGroupIndex,
    editors: editors.length ? editors : undefined
  }
}

/** Persist the current layout if anything restorable is open. */
export async function persistSessionRestore(): Promise<void> {
  try {
    const snap = captureSessionRestoreSnapshot()
    if (!snap) {
      await window.devterm.sessionRestore.clear()
      return
    }
    await window.devterm.sessionRestore.save(snap)
  } catch {
    /* ignore — restore is best-effort */
  }
}

export interface RestoreProgressFailure {
  /** Pending tab id for a failed host, when a tab could be painted. */
  sessionId?: string
  groupId: string
  title: string
  message: string
}

export interface RestoreProgress {
  /** All remote items in the snapshot, including hosts that failed immediately. */
  total: number
  ready: number
  failed: number
  /** Valid remote items in groups that have not been focused yet. */
  pending: number
  /** True once the active group's remote attempts have settled. */
  activeSettled: boolean
  failures: RestoreProgressFailure[]
}

export interface RestoreSessionOptions {
  onProgress?: (progress: RestoreProgress) => void
}

interface LazyRestoreGroup {
  groupId: string
  snapshotIndex: number
  snapshot: SessionRestoreSnapshot
  items: SessionRestoreItem[]
  sessionMap: Map<string, string>
  remoteItems: SessionRestoreItem[]
  ready: Set<string>
  failures: Map<string, RestoreProgressFailure>
  activeSettled: boolean
  connectPromise?: Promise<void>
}

/** Groups are painted during restore and connected when this map is activated. */
const lazyRestoreGroups = new Map<string, LazyRestoreGroup>()
let restoreProgressListener: ((progress: RestoreProgress) => void) | undefined
let activeRestoreGroupId: string | null = null
const restoredAgentItems = new Set<string>()
const restoredEditorKeys = new Set<string>()

function progressSnapshot(): RestoreProgress {
  const records = [...lazyRestoreGroups.values()]
  const total = records.reduce((n, r) => n + r.remoteItems.length, 0)
  const ready = records.reduce((n, r) => n + r.ready.size, 0)
  const failed = records.reduce((n, r) => n + r.failures.size, 0)
  return {
    total,
    ready,
    failed,
    pending: Math.max(0, total - ready - failed),
    activeSettled: activeRestoreGroupId
      ? lazyRestoreGroups.get(activeRestoreGroupId)?.activeSettled === true
      : true,
    failures: records.flatMap((r) => [...r.failures.values()])
  }
}

function emitRestoreProgress(): void {
  restoreProgressListener?.(progressSnapshot())
}

function statusMessage(sessionId: string, fallback: string): string {
  return useSessions.getState().sessions.find((s) => s.id === sessionId)?.status ?? fallback
}

/** Restore agents/editors that already have a real local/browser/remote session. */
async function restoreGroupExtras(record: LazyRestoreGroup, snap: SessionRestoreSnapshot) {
  const currentSessions = () => useSessions.getState().sessions
  for (const it of record.items) {
    if (!it.agentUiMode || !it.agentKind || restoredAgentItems.has(it.id)) continue
    const sid = record.sessionMap.get(it.id)
    const live = sid && currentSessions().find((s) => s.id === sid)
    // A deferred remote is intentionally restored after the group connects.
    if (!sid || !live || live.closed || live.deferredRemote) continue
    restoredAgentItems.add(it.id)
    try {
      // A floating-window IPC must not hold startup hydration forever. The
      // agent may still finish opening in the background; restore itself is
      // best-effort and moves on after this bounded wait.
      await withTimeout(
        setAgentUiMode(sid, it.agentUiMode, { kind: it.agentKind }),
        10_000,
        'agent restore timed out'
      )
    } catch {
      /* agent relaunch is best-effort */
    }
  }

  for (const [index, ed] of (snap.editors ?? []).entries()) {
    const key = `${index}:${ed.scope}:${ed.itemId ?? ''}:${ed.path}`
    if (restoredEditorKeys.has(key)) continue
    if (ed.scope === 'local') {
      restoredEditorKeys.add(key)
      try {
        useEditors.getState().open({ scope: 'local', path: ed.path })
      } catch {
        /* editor restore is best-effort */
      }
      continue
    }
    if (!ed.itemId || !record.items.some((it) => it.id === ed.itemId)) continue
    const sid = record.sessionMap.get(ed.itemId)
    const live = sid && currentSessions().find((s) => s.id === sid)
    if (!sid || !live || live.closed || live.deferredRemote) continue
    restoredEditorKeys.add(key)
    try {
      useEditors.getState().open({ scope: 'remote', sessionId: sid, path: ed.path })
    } catch {
      /* editor restore is best-effort */
    }
  }
}

async function connectRestoreGroup(
  record: LazyRestoreGroup,
  snap: SessionRestoreSnapshot
): Promise<void> {
  const jobs = record.remoteItems.map(async (it, index) => {
    const pendingId = record.sessionMap.get(it.id)
    // A missing/deleted saved connection has a failure entry but no tab to
    // connect; valid remotes all have a painted pending id here.
    if (!pendingId) return
    if (useSessions.getState().sessions.find((s) => s.id === pendingId)?.needsAuth) {
      record.failures.set(it.id, {
        sessionId: pendingId,
        groupId: record.groupId,
        title: it.title ?? 'Remote host',
        message: 'Authentication required'
      })
      emitRestoreProgress()
      return
    }
    await waitForRemoteConnectStagger(index)
    try {
      const sid = await useSessions.getState().connectDeferred(pendingId)
      if (sid) {
        record.sessionMap.set(it.id, sid)
        record.ready.add(it.id)
        record.failures.delete(it.id)
      } else {
        record.failures.set(it.id, {
          sessionId: pendingId,
          groupId: record.groupId,
          title: it.title ?? 'Remote host',
          message: statusMessage(pendingId, 'connection failed')
        })
      }
    } catch (e) {
      record.failures.set(it.id, {
        sessionId: pendingId,
        groupId: record.groupId,
        title: it.title ?? 'Remote host',
        message: e instanceof Error ? e.message : String(e)
      })
    }
    emitRestoreProgress()
  })
  await Promise.all(jobs)
  record.activeSettled = true
  emitRestoreProgress()
  await restoreGroupExtras(record, snap)
}

/** Connect a restored group when its group tab is focused. */
export function activateRestoredGroup(groupId: string): Promise<void> {
  const record = lazyRestoreGroups.get(groupId)
  if (!record) return Promise.resolve()
  if (record.connectPromise) return record.connectPromise
  record.connectPromise = connectRestoreGroup(record, record.snapshot)
  return record.connectPromise
}

/**
 * Reopen a snapshot into fresh groups. Returns the number of terminals
 * recreated (0 when nothing could be restored). Uses the same launch path as
 * workspaces.
 */
export async function restoreSessionSnapshot(
  snap: SessionRestoreSnapshot,
  conns: SavedConnection[],
  opts: RestoreSessionOptions = {}
): Promise<{ opened: number; attempted: number; incomplete: boolean }> {
  if (!snap?.groups?.length) return { opened: 0, attempted: 0, incomplete: false }

  let opened = 0
  let attempted = 0
  lazyRestoreGroups.clear()
  restoredAgentItems.clear()
  restoredEditorKeys.clear()
  restoreProgressListener = opts.onProgress
  activeRestoreGroupId = null
  let firstGroupId: string | null = null

  for (let i = 0; i < snap.groups.length; i++) {
    const g = snap.groups[i]
    const items = (g.items ?? []).filter(
      (it) =>
        it.kind === 'local' ||
        it.kind === 'browser' ||
        (it.kind === 'remote' &&
          (typeof it.connectionId === 'string' || typeof it.sshDraft?.host === 'string'))
    )
    if (!items.length) continue
    attempted += items.length

    const layout = useLayout.getState()
    const def = layout.groups.find((x) => x.id === DEFAULT_GROUP)
    const defEmpty =
      (!def?.root || (def.root.type === 'leaf' && def.root.tabs.length === 0)) &&
      useSessions.getState().sessions.length === 0

    const groupId: string =
      firstGroupId === null && defEmpty ? DEFAULT_GROUP : `sr-${crypto.randomUUID()}`
    const name = g.name || (i === 0 ? 'Terminals' : `Group ${i + 1}`)
    useLayout.getState().ensureGroup(groupId, name)

    const sessionMap = new Map<string, string>()
    const failures = new Map<string, RestoreProgressFailure>()
    for (const it of items) {
      if (it.kind === 'local') {
        sessionMap.set(
          it.id,
          useSessions.getState().addLocal({
            cwd: it.cwd,
            groupId,
            title: it.title,
            restoreScrollback: it.scrollback
          })
        )
      } else if (it.kind === 'browser') {
        sessionMap.set(
          it.id,
          useSessions.getState().addBrowser({
            url: it.url,
            groupId,
            browserTabs: it.browserTabs,
            browserActiveTab: it.browserActiveTab
          })
        )
      } else {
        const c = conns.find((x) => x.id === it.connectionId)
        let profile: SSHProfile | undefined
        let connectionId: string | undefined
        let connectionTitle: string | undefined
        let needsAuth = false
        let restoreSecretId: string | undefined
        if (c) {
          const { id: _id, name: connectionName, ...savedProfile } = c
          profile = savedProfile
          connectionId = it.connectionId
          connectionTitle = connectionName
        } else if (it.sshDraft) {
          const restored = profileFromSshDraft(it.sshDraft)
          profile = restored.profile
          needsAuth = restored.needsAuth
          restoreSecretId = it.sshDraft.secretId
        }
        if (!profile) {
          failures.set(it.id, {
            groupId,
            title: it.title ?? 'Remote host',
            message: it.connectionId
              ? `Saved connection not found: ${it.connectionId}`
              : 'SSH restore draft is missing'
          })
          continue
        }
        sessionMap.set(
          it.id,
          useSessions.getState().addDeferredRemote({
            profile,
            connectionId,
            startCwd: it.cwd,
            groupId,
            title: it.title ?? connectionTitle,
            restoreScrollback: it.scrollback,
            needsAuth,
            restoreSecretId
          })
        )
      }
    }

    const record: LazyRestoreGroup = {
      groupId,
      snapshotIndex: i,
      snapshot: snap,
      items,
      sessionMap,
      remoteItems: items.filter((it) => it.kind === 'remote'),
      ready: new Set(),
      failures,
      activeSettled: false
    }
    lazyRestoreGroups.set(groupId, record)
    if (!firstGroupId) firstGroupId = groupId
    opened += sessionMap.size

    // Reconcile immediately so the group tab/chrome exists before any SSH
    // attempt. The layout snapshot contains pending ids and is renamed in
    // place when connectDeferred swaps each id for its live session id.
    useLayout
      .getState()
      .sync(useSessions.getState().sessions.map((s) => ({ id: s.id, groupId: s.groupId })))
    const live = g.layout ? toLiveSnapshot(g.layout, sessionMap) : null
    if (live) useLayout.getState().restoreGroup(groupId, name, live, false)
  }

  const records = [...lazyRestoreGroups.values()]
  if (!records.length) {
    restoreProgressListener = undefined
    return { opened: 0, attempted, incomplete: attempted > 0 }
  }
  const preferred = snap.activeGroupIndex ?? 0
  const activeRecord =
    records.find((r) => r.snapshotIndex === preferred && r.sessionMap.size > 0) ??
    records.find((r) => r.sessionMap.size > 0)
  activeRestoreGroupId = activeRecord?.groupId ?? records[0].groupId
  useLayout.getState().setActiveGroup(activeRestoreGroupId)
  const activeSession = groupActiveSession(
    useLayout.getState().groups.find((g) => g.id === activeRestoreGroupId)
  )
  if (activeSession) useSessions.getState().setActive(activeSession)
  emitRestoreProgress()

  // Local PTYs and browser panes are already live in every group, so their
  // agents/editors may restore in parallel. Deferred remote extras wait for
  // that group to connect.
  const localExtras = Promise.all(records.map((r) => restoreGroupExtras(r, snap)))
  await activateRestoredGroup(activeRestoreGroupId)
  await localExtras

  if (useSettings.getState().remoteConnectMode === 'stagger') {
    records
      .filter((r) => r.groupId !== activeRestoreGroupId)
      .forEach((r, index) => {
        window.setTimeout(() => void activateRestoredGroup(r.groupId), (index + 1) * 300)
      })
  }

  const incomplete = records.some((r) => r.failures.size > 0)
  return { opened, attempted, incomplete }
}
