import { create } from 'zustand'

/**
 * Tiling layout for terminal panes (drag-to-arrange + split view).
 *
 * The layout is an n-ary split tree: internal `split` nodes divide space row-
 * or column-wise with any number of children; `leaf` nodes are panes that hold
 * one or more sessions as a tab group. The renderer flattens this tree into
 * absolute rects so that every terminal lives in ONE stable DOM layer and is
 * merely repositioned when the layout changes — never reparented (which would
 * unmount xterm and kill the local pty). See TerminalLayout.tsx.
 */

export type SplitDir = 'row' | 'col'
export type DropZone = 'center' | 'left' | 'right' | 'top' | 'bottom'

export interface LeafNode {
  type: 'leaf'
  id: string
  tabs: string[]
  active: string | null
}
export interface SplitNode {
  type: 'split'
  id: string
  dir: SplitDir
  children: LayoutNode[]
  /** Fractional sizes, parallel to `children`, summing to ~1. */
  sizes: number[]
}
export type LayoutNode = LeafNode | SplitNode

/** A persisted layout shape (no node ids — `restore` assigns fresh ones). */
export type LayoutSnapshot =
  | { type: 'leaf'; tabs: string[]; active?: string | null }
  | { type: 'split'; dir: SplitDir; sizes: number[]; children: LayoutSnapshot[] }

/** Rect in fractions of the container (0..1). */
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

let seq = 0
const nid = (p: string) => `${p}-${++seq}-${Date.now()}`
const mkLeaf = (tabs: string[]): LeafNode => ({
  type: 'leaf',
  id: nid('leaf'),
  tabs,
  active: tabs[tabs.length - 1] ?? null
})

// --- pure tree helpers -----------------------------------------------------

function findLeaf(n: LayoutNode | null, id: string): LeafNode | null {
  if (!n) return null
  if (n.type === 'leaf') return n.id === id ? n : null
  for (const c of n.children) {
    const r = findLeaf(c, id)
    if (r) return r
  }
  return null
}

function leafOf(n: LayoutNode | null, sid: string): LeafNode | null {
  if (!n) return null
  if (n.type === 'leaf') return n.tabs.includes(sid) ? n : null
  for (const c of n.children) {
    const r = leafOf(c, sid)
    if (r) return r
  }
  return null
}

function firstLeaf(n: LayoutNode): LeafNode {
  return n.type === 'leaf' ? n : firstLeaf(n.children[0])
}

export function allLeaves(n: LayoutNode | null, out: LeafNode[] = []): LeafNode[] {
  if (!n) return out
  if (n.type === 'leaf') out.push(n)
  else n.children.forEach((c) => allLeaves(c, out))
  return out
}

/** Immutably update a leaf by id. */
function updateLeaf(n: LayoutNode, id: string, fn: (l: LeafNode) => LeafNode): LayoutNode {
  if (n.type === 'leaf') return n.id === id ? fn(n) : n
  return { ...n, children: n.children.map((c) => updateLeaf(c, id, fn)) }
}

/** Immutably update a split by id. */
function updateSplit(n: LayoutNode, id: string, fn: (s: SplitNode) => SplitNode): LayoutNode {
  if (n.type === 'leaf') return n
  const next = { ...n, children: n.children.map((c) => updateSplit(c, id, fn)) }
  return next.id === id ? fn(next) : next
}

/** Replace a leaf (matched by id) with the result of `repl`. */
function replaceLeaf(n: LayoutNode, id: string, repl: (l: LeafNode) => LayoutNode): LayoutNode {
  if (n.type === 'leaf') return n.id === id ? repl(n) : n
  return { ...n, children: n.children.map((c) => replaceLeaf(c, id, repl)) }
}

/** Drop empty leaves and collapse single-child splits. */
function prune(n: LayoutNode | null): LayoutNode | null {
  if (!n) return null
  if (n.type === 'leaf') return n.tabs.length ? n : null
  const kids = n.children.map(prune).filter(Boolean) as LayoutNode[]
  if (kids.length === 0) return null
  if (kids.length === 1) return kids[0]
  const sizes = kids.length === n.children.length ? n.sizes : kids.map(() => 1 / kids.length)
  return { ...n, children: kids, sizes }
}

function removeTab(root: LayoutNode | null, sid: string): LayoutNode | null {
  if (!root) return null
  const owner = leafOf(root, sid)
  if (!owner) return root
  const updated = updateLeaf(root, owner.id, (l) => {
    const tabs = l.tabs.filter((t) => t !== sid)
    return { ...l, tabs, active: l.active === sid ? (tabs[tabs.length - 1] ?? null) : l.active }
  })
  return prune(updated)
}

/** Compute pane rects and split-divider handles from the tree (fractions). */
export function computeLayout(root: LayoutNode | null): {
  leaves: Array<{ leaf: LeafNode; rect: Rect }>
  handles: Array<{ splitId: string; index: number; dir: SplitDir; rect: Rect; span: number }>
} {
  const leaves: Array<{ leaf: LeafNode; rect: Rect }> = []
  const handles: Array<{
    splitId: string
    index: number
    dir: SplitDir
    rect: Rect
    span: number
  }> = []
  const walk = (n: LayoutNode, r: Rect): void => {
    if (n.type === 'leaf') {
      if (n.tabs.length === 0) return
      leaves.push({ leaf: n, rect: r })
      return
    }
    let sizes = n.sizes.length === n.children.length ? n.sizes : n.children.map(() => 1 / n.children.length)
    let total = sizes.reduce((a, b) => a + b, 0)
    if (total < 0.001) {
      sizes = n.children.map(() => 1 / n.children.length)
      total = sizes.reduce((a, b) => a + b, 0) || 1
    }
    let off = n.dir === 'row' ? r.x : r.y
    n.children.forEach((c, i) => {
      const frac = sizes[i] / total
      const cr: Rect =
        n.dir === 'row'
          ? { x: off, y: r.y, w: r.w * frac, h: r.h }
          : { x: r.x, y: off, w: r.w, h: r.h * frac }
      walk(c, cr)
      off += (n.dir === 'row' ? r.w : r.h) * frac
      if (i < n.children.length - 1) {
        handles.push({
          splitId: n.id,
          index: i,
          dir: n.dir,
          span: n.dir === 'row' ? r.w : r.h,
          rect:
            n.dir === 'row' ? { x: off, y: r.y, w: 0, h: r.h } : { x: r.x, y: off, w: r.w, h: 0 }
        })
      }
    })
  }
  if (root) walk(root, { x: 0, y: 0, w: 1, h: 1 })
  return { leaves, handles }
}

/** The default group id holding all ungrouped (loose) terminals. */
export const DEFAULT_GROUP = 'default'

/**
 * A top-level terminal group. The default group holds loose terminals; each
 * launched workspace becomes its own group, shown as a tab in the group bar with
 * its own split tree. Groups keep terminals from different workspaces side by
 * side instead of one overwriting the other.
 */
export interface Group {
  id: string
  name: string
  root: LayoutNode | null
  activeLeaf: string | null
}

interface RootState {
  root: LayoutNode | null
  activeLeaf: string | null
}

/** Reconcile one group's tree with the live session id list (add/remove/rename). */
function reconcile(prev: RootState, ids: string[]): RootState {
  const present = allLeaves(prev.root).flatMap((l) => l.tabs)
  const removed = present.filter((id) => !ids.includes(id))
  const added = ids.filter((id) => !present.includes(id))
  let root = prev.root
  let activeLeaf = prev.activeLeaf

  // Common case: a pending session's id was swapped for its real id — rename in
  // place so the tab keeps its position. Gate on the pending- prefix: a genuine
  // close-A/open-B pair batched by React 18 must not be treated as a rename.
  if (removed.length === 1 && added.length === 1 && removed[0].startsWith('pending-')) {
    const owner = leafOf(root, removed[0])
    if (owner) {
      root = updateLeaf(root!, owner.id, (l) => ({
        ...l,
        tabs: l.tabs.map((t) => (t === removed[0] ? added[0] : t)),
        active: l.active === removed[0] ? added[0] : l.active
      }))
      return { root, activeLeaf: activeLeaf ?? owner.id }
    }
  }

  for (const id of removed) root = removeTab(root, id)
  for (const id of added) {
    if (!root) {
      const l = mkLeaf([id])
      root = l
      activeLeaf = l.id
    } else {
      const target = (activeLeaf && findLeaf(root, activeLeaf)) || firstLeaf(root)
      root = updateLeaf(root, target.id, (l) => ({ ...l, tabs: [...l.tabs, id], active: id }))
      activeLeaf = target.id
    }
  }
  if (!root) activeLeaf = null
  else if (!activeLeaf || !findLeaf(root, activeLeaf)) activeLeaf = firstLeaf(root).id
  return { root, activeLeaf }
}

/** Build a fresh tree (new node ids) from a persisted snapshot. */
function buildSnapshot(snap: LayoutSnapshot | null): RootState {
  if (!snap) return { root: null, activeLeaf: null }
  let firstLeafId: string | null = null
  const build = (n: LayoutSnapshot): LayoutNode => {
    if (n.type === 'leaf') {
      const id = nid('leaf')
      if (!firstLeafId) firstLeafId = id
      return {
        type: 'leaf',
        id,
        tabs: n.tabs,
        active: n.active ?? n.tabs[n.tabs.length - 1] ?? null
      }
    }
    return {
      type: 'split',
      id: nid('split'),
      dir: n.dir,
      sizes: n.sizes,
      children: n.children.map(build)
    }
  }
  return { root: build(snap), activeLeaf: firstLeafId }
}

/** Active session id of a group (the active tab of its active leaf), if any. */
export function groupActiveSession(g: Group | undefined): string | null {
  if (!g || !g.root) return null
  const leaf = (g.activeLeaf && allLeaves(g.root).find((l) => l.id === g.activeLeaf)) || null
  return leaf?.active ?? allLeaves(g.root)[0]?.active ?? null
}

interface LayoutState {
  groups: Group[]
  activeGroupId: string
  /**
   * The session currently magnified in focus mode, or null. Focus mode centers
   * and enlarges one pane with the rest dimmed behind a backdrop; it only repositions
   * the existing slot (never reparents it). Cleared on group switch and when the
   * focused session goes away.
   */
  focusedId: string | null
  /**
   * Per-group metadata (transient, in-memory only). Used to flag a group that
   * was launched from a saved workspace, so the group bar can offer a
   * "Save changes back to this workspace" action. Cleared when the group goes
   * away. Keyed by group id.
   */
  groupFlags: Record<string, { launchedFromWorkspaceId?: string }>
  /** Enter/leave focus mode for a specific session (null exits). */
  setFocus: (id: string | null) => void
  /** Toggle focus mode for a session (focus it, or exit if it's already focused). */
  toggleFocus: (sid: string | null) => void
  /** Reconcile every group's tree with the live sessions (each carries its groupId). */
  sync: (sessions: Array<{ id: string; groupId?: string }>) => void
  /** Create an (empty) group if it doesn't exist yet — used before launching a workspace. */
  ensureGroup: (id: string, name: string) => void
  /** Create a fresh empty group on demand, make it active, and return its id. */
  createGroup: (name?: string) => string
  setActiveGroup: (id: string) => void
  setActiveTab: (leafId: string, sid: string) => void
  focusLeaf: (leafId: string) => void
  /** Reorder/move a tab into a leaf at a given index (drag within a strip). */
  reorderTab: (sid: string, targetLeafId: string, index: number) => void
  /** Drag-drop a session onto a pane: center = stack as tab, edge = split. */
  drop: (sid: string, targetLeafId: string, zone: DropZone) => void
  /** Collapse a split pane: move all its tabs into another leaf and prune. */
  mergeLeaf: (leafId: string) => void
  /** Adjust a split divider; delta is a fraction of the container. */
  resize: (splitId: string, index: number, delta: number) => void
  /** Set a group's tree from a workspace snapshot (fresh node ids) and focus it. */
  restoreGroup: (id: string, name: string, snap: LayoutSnapshot | null) => void
  /** Tag a group as launched from a given workspace (so the "save back" action shows). */
  flagGroupLaunched: (groupId: string, workspaceId: string) => void
  /** Drop the launched-from flag once the user has saved back. */
  clearGroupLaunched: (groupId: string) => void
}

/** Apply a tree transform to the active group only. */
function patchActive(s: LayoutState, fn: (g: RootState) => RootState | null): Partial<LayoutState> {
  const g = s.groups.find((x) => x.id === s.activeGroupId)
  if (!g) return {}
  const next = fn({ root: g.root, activeLeaf: g.activeLeaf })
  if (!next) return {}
  return {
    groups: s.groups.map((x) =>
      x.id === s.activeGroupId ? { ...x, root: next.root, activeLeaf: next.activeLeaf } : x
    )
  }
}

export const useLayout = create<LayoutState>((set) => ({
  groups: [{ id: DEFAULT_GROUP, name: 'Terminals', root: null, activeLeaf: null }],
  activeGroupId: DEFAULT_GROUP,
  focusedId: null,
  groupFlags: {},

  setFocus: (id) => set({ focusedId: id }),
  toggleFocus: (sid) => set((s) => ({ focusedId: sid && s.focusedId !== sid ? sid : null })),

  sync: (sessions) =>
    set((s) => {
      const idsByGroup = new Map<string, string[]>()
      for (const ss of sessions) {
        const gid = ss.groupId || DEFAULT_GROUP
        if (!idsByGroup.has(gid)) idsByGroup.set(gid, [])
        idsByGroup.get(gid)!.push(ss.id)
      }
      // Preserve existing group order + names; append any new groupIds from sessions.
      const known = new Map(s.groups.map((g) => [g.id, g]))
      const order = s.groups.map((g) => g.id)
      for (const gid of idsByGroup.keys()) {
        if (!known.has(gid)) {
          known.set(gid, { id: gid, name: gid, root: null, activeLeaf: null })
          order.push(gid)
        }
      }
      const groups: Group[] = []
      for (const gid of order) {
        const prev = known.get(gid)!
        const ids = idsByGroup.get(gid) ?? []
        // Drop emptied groups (including the active one — closing a group's last
        // terminal should remove its tab); the default group always stays. New
        // groups are created together with their first terminal (see App's "＋"
        // and spinOffGroup), so a group is never left transiently empty here.
        if (ids.length === 0 && gid !== DEFAULT_GROUP) continue
        const rec = reconcile({ root: prev.root, activeLeaf: prev.activeLeaf }, ids)
        // Reuse the previous Group object when nothing changed so unchanged
        // groups don't re-render subscribers on every sync.
        groups.push(
          rec.root === prev.root && rec.activeLeaf === prev.activeLeaf
            ? prev
            : { ...prev, root: rec.root, activeLeaf: rec.activeLeaf }
        )
      }
      if (!groups.some((g) => g.id === DEFAULT_GROUP)) {
        const prev = known.get(DEFAULT_GROUP)
        groups.unshift({
          id: DEFAULT_GROUP,
          name: prev?.name ?? 'Terminals',
          root: null,
          activeLeaf: null
        })
      }
      let activeGroupId = groups.some((g) => g.id === s.activeGroupId)
        ? s.activeGroupId
        : DEFAULT_GROUP
      // Don't strand the user on an empty group while another holds terminals
      // (e.g. closed the last loose terminal with a workspace still open).
      const activeG = groups.find((g) => g.id === activeGroupId)
      if (activeG && !activeG.root) {
        const populated = groups.find((g) => g.root)
        if (populated) activeGroupId = populated.id
      }
      // Drop focus mode if its session closed.
      const liveIds = new Set(sessions.map((ss) => ss.id))
      const focusedId = s.focusedId && liveIds.has(s.focusedId) ? s.focusedId : null
      // Prune group flags for groups that no longer exist (group closed → flag
      // is meaningless).
      const liveGroupIds = new Set(groups.map((g) => g.id))
      let groupFlags = s.groupFlags
      let pruned = false
      for (const gid of Object.keys(s.groupFlags)) {
        if (!liveGroupIds.has(gid)) pruned = true
      }
      if (pruned) {
        groupFlags = {}
        for (const [gid, flag] of Object.entries(s.groupFlags)) {
          if (liveGroupIds.has(gid)) groupFlags[gid] = flag
        }
      }
      return { groups, activeGroupId, focusedId, groupFlags }
    }),

  ensureGroup: (id, name) =>
    set((s) =>
      s.groups.some((g) => g.id === id)
        ? s
        : { groups: [...s.groups, { id, name, root: null, activeLeaf: null }] }
    ),

  createGroup: (name) => {
    const id = `grp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    set((s) => {
      const n = s.groups.filter((g) => g.id !== DEFAULT_GROUP).length + 1
      const group: Group = { id, name: name ?? `Group ${n}`, root: null, activeLeaf: null }
      return { groups: [...s.groups, group], activeGroupId: id, focusedId: null }
    })
    return id
  },

  setActiveGroup: (id) => set((s) => {
    if (!s.groups.some((g) => g.id === id)) return s
    return { activeGroupId: id, focusedId: null }
  }),

  setActiveTab: (leafId, sid) =>
    set((s) =>
      patchActive(s, (g) => ({
        root: g.root ? updateLeaf(g.root, leafId, (l) => (l.tabs.includes(sid) ? { ...l, active: sid } : l)) : g.root,
        activeLeaf: leafId
      }))
    ),

  focusLeaf: (leafId) => set((s) =>
    patchActive(s, (g) => {
      if (!g.root || !findLeaf(g.root, leafId)) return null
      return { root: g.root, activeLeaf: leafId }
    })
  ),

  reorderTab: (sid, targetLeafId, index) =>
    set((s) =>
      patchActive(s, (g) => {
        if (!g.root) return null
        const src = leafOf(g.root, sid)
        if (!src) return null
        let root: LayoutNode | null =
          src.id !== targetLeafId
            ? removeTab(g.root, sid)
            : updateLeaf(g.root, targetLeafId, (l) => ({
                ...l,
                tabs: l.tabs.filter((t) => t !== sid)
              }))
        if (!root || !findLeaf(root, targetLeafId)) return { root, activeLeaf: root ? firstLeaf(root).id : null }
        root = updateLeaf(root, targetLeafId, (l) => {
          const tabs = [...l.tabs]
          tabs.splice(Math.max(0, Math.min(index, tabs.length)), 0, sid)
          return { ...l, tabs, active: sid }
        })
        return { root, activeLeaf: targetLeafId }
      })
    ),

  drop: (sid, targetLeafId, zone) =>
    set((s) =>
      patchActive(s, (g) => {
        if (!g.root) return null
        const src = leafOf(g.root, sid)
        if (!src) return null

        if (zone === 'center') {
          let root: LayoutNode | null =
            src.id !== targetLeafId
              ? removeTab(g.root, sid)
              : updateLeaf(g.root, targetLeafId, (l) => ({
                  ...l,
                  tabs: l.tabs.filter((t) => t !== sid)
                }))
          if (!root || !findLeaf(root, targetLeafId)) return { root, activeLeaf: root ? firstLeaf(root).id : null }
          root = updateLeaf(root, targetLeafId, (l) => ({
            ...l,
            tabs: [...l.tabs, sid],
            active: sid
          }))
          return { root, activeLeaf: targetLeafId }
        }

        // Splitting a single-tab pane onto its own edge is a no-op.
        if (src.id === targetLeafId && src.tabs.length === 1) return null
        const root0 = removeTab(g.root, sid)
        if (!root0 || !findLeaf(root0, targetLeafId))
          return { root: root0, activeLeaf: root0 ? firstLeaf(root0).id : null }
        const nl = mkLeaf([sid])
        const dir: SplitDir = zone === 'left' || zone === 'right' ? 'row' : 'col'
        const before = zone === 'left' || zone === 'top'
        const root = replaceLeaf(root0, targetLeafId, (t) => ({
          type: 'split',
          id: nid('split'),
          dir,
          children: before ? [nl, t] : [t, nl],
          sizes: [0.5, 0.5]
        }))
        return { root, activeLeaf: nl.id }
      })
    ),

  mergeLeaf: (leafId) =>
    set((s) =>
      patchActive(s, (g) => {
        if (!g.root) return null
        const leaves = allLeaves(g.root)
        if (leaves.length < 2) return null
        const src = leaves.find((l) => l.id === leafId)
        // Merge into the closest other pane (first in document order).
        const dest = leaves.find((l) => l.id !== leafId)
        if (!src || !dest || src.tabs.length === 0) return null
        const moving = [...src.tabs]
        let root: LayoutNode | null = g.root
        for (const sid of moving) root = removeTab(root, sid) // empties + prunes src
        if (!root || !findLeaf(root, dest.id)) return null
        root = updateLeaf(root, dest.id, (l) => ({
          ...l,
          tabs: [...l.tabs, ...moving],
          active: moving[moving.length - 1]
        }))
        return { root, activeLeaf: dest.id }
      })
    ),

  resize: (splitId, index, delta) =>
    set((s) =>
      patchActive(s, (g) => {
        if (!g.root) return null
        const min = 0.18
        const root = updateSplit(g.root, splitId, (sp) => {
          const sizes = [...sp.sizes]
          let a = sizes[index] + delta
          let b = sizes[index + 1] - delta
          for (let pass = 0; pass < 2; pass++) {
            if (a < min) {
              const d = min - a
              a = min
              b -= d
            }
            if (b < min) {
              const d = min - b
              b = min
              a -= d
            }
          }
          sizes[index] = a
          sizes[index + 1] = b
          return { ...sp, sizes }
        })
        return { root, activeLeaf: g.activeLeaf }
      })
    ),

  restoreGroup: (id, name, snap) =>
    set((s) => {
      const built = buildSnapshot(snap)
      const exists = s.groups.some((g) => g.id === id)
      const groups = exists
        ? s.groups.map((g) => (g.id === id ? { ...g, name, ...built } : g))
        : [...s.groups, { id, name, ...built }]
      return { groups, activeGroupId: id, focusedId: null }
    }),

  flagGroupLaunched: (groupId, workspaceId) =>
    set((s) => ({
      groupFlags: { ...s.groupFlags, [groupId]: { launchedFromWorkspaceId: workspaceId } }
    })),

  clearGroupLaunched: (groupId) =>
    set((s) => {
      const next = { ...s.groupFlags }
      delete next[groupId]
      return { groupFlags: next }
    })
}))
