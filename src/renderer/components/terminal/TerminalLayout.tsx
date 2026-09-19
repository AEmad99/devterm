import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import TerminalView from './TerminalView'
import RemoteSessionView from './RemoteSessionView'
import LocalSessionView from './LocalSessionView'
import BrowserPane from './BrowserPane'
import { useSessions, type Session } from '../../store/sessions'
import { useEditors } from '../../store/editors'
import { useSettings } from '../../store/settings'
import {
  useLayout,
  computeLayout,
  DEFAULT_GROUP,
  type DropZone,
  type LeafNode,
  type Rect
} from '../../store/layout'
import {
  IconMerge,
  IconPlus,
  IconFocus,
  IconClose,
  IconTmux,
  IconChevronLeft,
  IconChevronRight,
  IconMore,
  IconSplit
} from '../common/Icons'
import PaneAgentControls from './PaneAgentControls'
import { focusTerminal, openTmuxPicker } from '../../lib/terms'
import { deriveTabLabel } from '../../lib/tab-label'
import TabStatusDot from './TabStatusDot'
import { useEscapeKey } from '../../lib/useEscapeKey'
import { canHibernateSession } from '../../lib/hibernate'

const TAB_H = 28 // px height of a pane's tab strip — keep in sync with --tab-h

// Centered, enlarged rect used for the magnified pane in focus mode. It sits
// above the dimming backdrop (see .term-slot.focused / .focus-backdrop in CSS).
// No explicit `visibility` here: it must inherit, so hiding the whole Terminals
// view (visibility on an ancestor) also hides a focused slot.
const FOCUSED_SLOT: React.CSSProperties = {
  left: 12,
  top: 12,
  right: 12,
  bottom: 12,
  zIndex: 6
}

const pct = (n: number) => `${n * 100}%`

/** Drop zone from a cursor position within a body rect (edges split, middle stacks). */
function zoneAt(px: number, py: number, w: number, h: number): DropZone {
  const fx = px / w
  const fy = py / h
  const d = { left: fx, right: 1 - fx, top: fy, bottom: 1 - fy }
  const min = Math.min(d.left, d.right, d.top, d.bottom)
  if (min > 0.28) return 'center'
  if (min === d.left) return 'left'
  if (min === d.right) return 'right'
  if (min === d.top) return 'top'
  return 'bottom'
}

function indicatorStyle(zone: DropZone): React.CSSProperties {
  switch (zone) {
    case 'left':
      return { left: 0, top: 0, width: '50%', height: '100%' }
    case 'right':
      return { left: '50%', top: 0, width: '50%', height: '100%' }
    case 'top':
      return { left: 0, top: 0, width: '100%', height: '50%' }
    case 'bottom':
      return { left: 0, top: '50%', width: '100%', height: '50%' }
    default:
      return { inset: 0 }
  }
}

export default function TerminalLayout({
  sessions,
  onNewTerminal,
  onRequestCloseSession
}: {
  sessions: Session[]
  onNewTerminal?: () => void
  /** Ask the owner to close a session (confirmation lives there). Falls back to direct close. */
  onRequestCloseSession?: (sid: string) => void
}) {
  // The active group's tree drives the panes/chrome; sessions in other groups
  // still render in the term-layer (hidden) so their PTYs/shells stay alive.
  // All groups are needed (not just the active one) so hidden sessions can keep
  // their own group's real pane geometry — see the slots map below.
  const groups = useLayout((s) => s.groups)
  const activeGroupId = useLayout((s) => s.activeGroupId)
  const root = groups.find((g) => g.id === activeGroupId)?.root ?? null
  const activeLeaf = useLayout(
    (s) => s.groups.find((g) => g.id === s.activeGroupId)?.activeLeaf ?? null
  )
  // Pull only the (stable) action handles — subscribing to the whole store here
  // would re-render the entire pane tree on every unrelated layout change.
  const setActiveTab = useLayout((s) => s.setActiveTab)
  const resize = useLayout((s) => s.resize)
  const mergeLeaf = useLayout((s) => s.mergeLeaf)
  const reorderTab = useLayout((s) => s.reorderTab)
  const drop = useLayout((s) => s.drop)
  const focusedId = useLayout((s) => s.focusedId)
  const toggleFocus = useLayout((s) => s.toggleFocus)
  const setSessionActive = useSessions((s) => s.setActive)
  const setCustomTitle = useSessions((s) => s.setCustomTitle)
  const close = useSessions((s) => s.close)
  const addLocal = useSessions((s) => s.addLocal)
  const equalize = useLayout((s) => s.equalize)
  const editorBlur = useEditors((s) => s.blur)
  const editorCloseForSession = useEditors((s) => s.closeForSession)
  const editorDocs = useEditors((s) => s.docs)
  const inactivePaneDimming = useSettings((s) => s.inactivePaneDimming)
  const hibernateEnabled = useSettings((s) => s.hibernateEnabled)
  const hibernateAfterMs = useSettings((s) => s.hibernateAfterMs)

  const panesRef = useRef<HTMLDivElement>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [over, setOver] = useState<{ leafId: string; zone: DropZone } | null>(null)
  const [hibernatedIds, setHibernatedIds] = useState<Set<string>>(() => new Set())
  const [trayHidden, setTrayHidden] = useState(false)
  const hibernateTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const hibernateConfigRef = useRef<{ enabled: boolean; afterMs: number } | null>(null)

  // Tray-resident close keeps every React session mounted but disposes each
  // live xterm surface through the same main-side ring gate used by ordinary
  // hidden-group hibernation. Showing the window flips this back and replays
  // the retained ANSI output without changing session ids or process leases.
  useEffect(() => window.devterm.window.onTrayMode(setTrayHidden), [])

  const dirtyEditorFor = useCallback(
    (sessionId: string) =>
      editorDocs.some(
        (doc) =>
          doc.state === 'ready' &&
          doc.content !== doc.savedContent &&
          (doc.scope === 'local' || doc.sessionId === sessionId)
      ),
    [editorDocs]
  )

  // Hidden groups keep their React slots and process leases, but after a quiet
  // delay their renderer xterm surfaces can be disposed. The timer is owned by
  // the layout so focusing a group cancels/wakes the whole group immediately.
  useEffect(() => {
    const timers = hibernateTimersRef.current
    const config = hibernateConfigRef.current
    if (!config || config.enabled !== hibernateEnabled || config.afterMs !== hibernateAfterMs) {
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
      hibernateConfigRef.current = { enabled: hibernateEnabled, afterMs: hibernateAfterMs }
    }

    const liveIds = new Set(sessions.map((session) => session.id))
    setHibernatedIds((current) => {
      if (!hibernateEnabled) return current.size === 0 ? current : new Set()
      const next = new Set([...current].filter((id) => liveIds.has(id)))
      for (const session of sessions) {
        if ((session.groupId || DEFAULT_GROUP) === activeGroupId) next.delete(session.id)
        else if (
          session.needsAttention ||
          session.agentPendingApproval ||
          dirtyEditorFor(session.id)
        ) {
          next.delete(session.id)
        }
      }
      return next.size === current.size && [...next].every((id) => current.has(id)) ? current : next
    })

    for (const [id, timer] of timers) {
      const session = sessions.find((item) => item.id === id)
      const stillEligible =
        !!session &&
        canHibernateSession(session, activeGroupId, dirtyEditorFor(session.id)) &&
        hibernateEnabled
      if (!stillEligible) {
        clearTimeout(timer)
        timers.delete(id)
      }
    }

    if (!hibernateEnabled) return
    for (const session of sessions) {
      if (!canHibernateSession(session, activeGroupId, dirtyEditorFor(session.id))) continue
      if (hibernatedIds.has(session.id) || timers.has(session.id)) continue
      const id = session.id
      timers.set(
        id,
        setTimeout(() => {
          timers.delete(id)
          const current = useSessions.getState().sessions.find((item) => item.id === id)
          if (!current || !useSettings.getState().hibernateEnabled) return
          const docs = useEditors.getState().docs
          const dirty = docs.some(
            (doc) =>
              doc.state === 'ready' &&
              doc.content !== doc.savedContent &&
              (doc.scope === 'local' || doc.sessionId === id)
          )
          if (canHibernateSession(current, useLayout.getState().activeGroupId, dirty)) {
            setHibernatedIds((previous) => {
              if (previous.has(id)) return previous
              const next = new Set(previous)
              next.add(id)
              return next
            })
          }
        }, hibernateAfterMs)
      )
    }
  }, [
    sessions,
    activeGroupId,
    editorDocs,
    dirtyEditorFor,
    hibernateEnabled,
    hibernateAfterMs,
    hibernatedIds
  ])

  useEffect(
    () => () => {
      for (const timer of hibernateTimersRef.current.values()) clearTimeout(timer)
      hibernateTimersRef.current.clear()
    },
    []
  )

  // Dropping a tab onto the group bar moves it to another group, which unmounts
  // the dragged tab before its `dragend` can fire — leaving `dragId` (and the
  // `.dragging` pane-dropzone overlay that swallows clicks) stuck on, so the
  // terminal becomes uninteractable. The active group's tree always changes on
  // such a move, so reset drag state whenever it does. A normal in-group drop
  // already clears it via onDrop; this just makes the cleanup unconditional.
  useEffect(() => {
    setDragId(null)
    setOver(null)
  }, [root])

  // Extra safety net: if a drag is cancelled or the source tab is unmounted
  // without firing `dragend`, the dropzone overlay would stay pointer-active and
  // block scrollbars / clicks until something mutates the tree. Clear it on any
  // window-level dragend so the UI can never stay stuck in drag mode.
  useEffect(() => {
    const clear = () => {
      setDragId(null)
      setOver(null)
    }
    window.addEventListener('dragend', clear)
    return () => window.removeEventListener('dragend', clear)
  }, [])

  const byId = useMemo(() => new Map(sessions.map((s) => [s.id, s])), [sessions])
  // Rects for EVERY group's tree, not just the active one. Hidden slots are
  // hidden with `visibility` (not `display:none`), so a hidden terminal keeps
  // its true pane geometry, its ResizeObserver keeps firing, and xterm + the
  // pty/ssh backend stay fitted while unseen. Switching tabs/groups then needs
  // no resize at all — resizing-on-reveal is what used to garble the screen
  // (ConPTY/PSReadLine repaint at mismatched columns, output clipped at stale
  // widths).
  const layouts = useMemo(
    () => groups.map((g) => ({ groupId: g.id, ...computeLayout(g.root) })),
    [groups]
  )
  const { leaves, handles } = useMemo(
    () => layouts.find((l) => l.groupId === activeGroupId) ?? { leaves: [], handles: [] },
    [layouts, activeGroupId]
  )
  // sessionId -> its slot geometry across all groups (+ whether it's the active
  // tab of its leaf, whether its leaf is the active leaf, and which group owns it).
  const slots = useMemo(() => {
    const m = new Map<
      string,
      { rect: Rect; activeTab: boolean; activeLeaf: boolean; groupId: string }
    >()
    for (const gl of layouts)
      for (const { leaf, rect } of gl.leaves)
        for (const t of leaf.tabs)
          m.set(t, {
            rect,
            activeTab: leaf.active === t,
            activeLeaf: leaf.id === activeLeaf,
            groupId: gl.groupId
          })
    return m
  }, [layouts, activeLeaf])
  // sessionId -> the active-group leaf that currently owns it (for focus-on-click).
  const leafOfSession = useMemo(() => {
    const m = new Map<string, string>()
    leaves.forEach(({ leaf }) => leaf.tabs.forEach((t) => m.set(t, leaf.id)))
    return m
  }, [leaves])

  // Focus (magnify) mode only applies when the focused session belongs to the
  // group currently drawn here (focus is cleared on group switch, but guard
  // anyway so a stray id can't dim a group that doesn't own it).
  const focusedHere = !!focusedId && leafOfSession.has(focusedId)

  const focusSession = (sid: string) => {
    const leafId = leafOfSession.get(sid)
    if (leafId) setActiveTab(leafId, sid)
    setSessionActive(sid)
    editorBlur()
  }

  const closeSession = (sid: string) => {
    editorCloseForSession(sid)
    close(sid)
  }

  /** Close through the owner's guard when available (confirm live agent/process). */
  const requestClose = (sid: string) => {
    if (onRequestCloseSession) onRequestCloseSession(sid)
    else closeSession(sid)
  }

  /**
   * Split the active pane with a brand-new local shell. The new session is
   * synced into the layout synchronously before splitting so the tree always
   * knows about it (App's debounced sync would otherwise race the split).
   */
  const splitWithNewTerminal = (sid: string, zone: DropZone) => {
    const s = sessions.find((x) => x.id === sid)
    if (!s) return
    const gid = s.groupId || DEFAULT_GROUP
    const newId = addLocal({ groupId: gid })
    useLayout
      .getState()
      .sync(
        [...sessions, { id: newId, groupId: gid }].map((x) => ({ id: x.id, groupId: x.groupId }))
      )
    useLayout.getState().splitBeside(sid, newId, zone)
    useSessions.getState().setActive(newId)
    focusTerminal(newId)
  }

  /** Close every tab in a pane (confirmation per session via requestClose). */
  const closePane = (leafId: string) => {
    const leaf = leaves.find((x) => x.leaf.id === leafId)?.leaf
    if (!leaf) return
    for (const sid of leaf.tabs) requestClose(sid)
  }

  /** Pull a tab into its own fresh group. */
  const moveToNewGroup = (sid: string) => {
    const gid = useLayout.getState().createGroup()
    useSessions.getState().setGroup(sid, gid)
  }

  // --- splitter drag (pointer-based) ---
  const beginResize = (
    e: React.PointerEvent,
    splitId: string,
    index: number,
    dir: 'row' | 'col',
    spanFrac: number
  ) => {
    e.preventDefault()
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
    const box = panesRef.current?.getBoundingClientRect()
    const containerSpan = dir === 'row' ? (box?.width ?? 1) : (box?.height ?? 1)
    const span = Math.max(1, containerSpan * spanFrac)
    let last = dir === 'row' ? e.clientX : e.clientY
    // Pointer events fire faster than frames (120–1000 Hz). Coalesce them into
    // one store write per animation frame so the layout re-renders at most once
    // per frame instead of N times — the main source of resize lag.
    let cur = last
    let raf = 0
    const flush = () => {
      raf = 0
      resize(splitId, index, (cur - last) / span)
      last = cur
    }
    const move = (ev: PointerEvent) => {
      cur = dir === 'row' ? ev.clientX : ev.clientY
      if (!raf) raf = requestAnimationFrame(flush)
    }
    const up = () => {
      if (raf) cancelAnimationFrame(raf)
      if (cur !== last) resize(splitId, index, (cur - last) / span) // settle final delta
      // Capture may already be lost (e.g. after pointercancel) — releasing then throws.
      try {
        if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId)
      } catch {
        /* capture already released */
      }
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  const slotBodyStyle = (rect: Rect): React.CSSProperties => ({
    left: pct(rect.x),
    top: `calc(${pct(rect.y)} + ${TAB_H}px)`,
    width: pct(rect.w),
    height: `calc(${pct(rect.h)} - ${TAB_H}px)`
  })

  return (
    <div
      className={`panes tiling ${dragId ? 'dragging' : ''} ${focusedHere ? 'focused' : ''}`}
      ref={panesRef}
    >
      {/* Layer 1: terminals — one stable slot per session, never reparented. */}
      <div className="term-layer">
        {sessions.map((s) => {
          const slot = slots.get(s.id)
          const isFocused = focusedHere && s.id === focusedId
          const visible = isFocused || (slot?.groupId === activeGroupId && slot.activeTab)
          const rect = slot?.rect ?? { x: 0, y: 0, w: 1, h: 1 }
          // A non-visible slot gets `.term-hidden` (visibility:hidden + an
          // off-screen translate) — never display:none, which collapses it to
          // 0×0 so the terminal can't refit until reveal (the resize storm that
          // corrupted/clipped output). Off-screen keeps the slot's real geometry
          // (so it stays fitted) AND makes xterm pause its render loop instead of
          // repainting every PTY chunk while backgrounded. Visible slots carry no
          // visibility/transform so they inherit (and can be hidden by) ancestor
          // view switches.
          const isHidden = !isFocused && !visible
          const isHibernated =
            (s.kind === 'local' || s.kind === 'remote') && (trayHidden || hibernatedIds.has(s.id))
          const isInactive =
            inactivePaneDimming && !isFocused && visible && !!slot && !slot.activeLeaf
          const style: React.CSSProperties = isFocused ? { ...FOCUSED_SLOT } : slotBodyStyle(rect)
          // Pane-level attention ring (cmux-style): approval pending beats
          // finished-agent attention. Hidden slots skip the pulse so off-screen
          // groups don't animate forever.
          const attentionClass =
            !isHidden && s.agentPendingApproval
              ? 'attention-pending'
              : !isHidden && s.needsAttention
                ? 'attention-needed'
                : ''
          return (
            <div
              key={s.id}
              className={`term-slot ${isFocused ? 'focused' : ''} ${isHidden ? 'term-hidden' : ''} ${
                isInactive ? 'inactive' : ''
              } ${attentionClass}`.trim()}
              style={style}
              data-attention={
                s.agentPendingApproval ? 'pending' : s.needsAttention ? 'needed' : undefined
              }
              data-hibernated={isHibernated ? 'true' : undefined}
              onMouseDownCapture={() => focusSession(s.id)}
            >
              {isFocused && (
                <button
                  className="focus-exit"
                  title="Exit focus (Esc)"
                  onClick={(e) => {
                    e.stopPropagation()
                    toggleFocus(s.id)
                  }}
                >
                  <IconClose size={14} />
                </button>
              )}
              {s.kind === 'browser' ? (
                <BrowserPane session={s} />
              ) : s.kind === 'remote' ? (
                <RemoteSessionView session={s} hibernated={isHibernated} />
              ) : s.kind === 'local' ? (
                <LocalSessionView session={s} hibernated={isHibernated} />
              ) : (
                <TerminalView session={s} hibernated={isHibernated} />
              )}
            </div>
          )
        })}
        {focusedHere && (
          <div
            className="focus-backdrop"
            title="Exit focus"
            onClick={() => toggleFocus(focusedId)}
          />
        )}
      </div>

      {/* Layer 2: chrome — tab strips, pane borders, drop targets, dividers. */}
      <div className="chrome-layer">
        {leaves.map(({ leaf, rect }) => (
          <PaneChrome
            key={leaf.id}
            leaf={leaf}
            rect={rect}
            isActive={leaf.id === activeLeaf}
            sessions={byId}
            dragId={dragId}
            canMerge={leaves.length > 1}
            onNewTerminal={onNewTerminal}
            over={over?.leafId === leaf.id ? over.zone : null}
            onToggleFocus={toggleFocus}
            onTabClick={focusSession}
            onTabClose={requestClose}
            onRename={setCustomTitle}
            onMerge={() => mergeLeaf(leaf.id)}
            onEqualize={equalize}
            onClosePane={() => closePane(leaf.id)}
            onSplit={splitWithNewTerminal}
            onMoveToNewGroup={moveToNewGroup}
            onDragStart={setDragId}
            onDragEnd={() => {
              setDragId(null)
              setOver(null)
            }}
            onZone={(zone) =>
              // No-op when the hovered zone is unchanged: returning the same
              // object lets React bail out, so dragover doesn't re-render the
              // tree on every mouse tick — only when the target zone changes.
              setOver((prev) =>
                prev && prev.leafId === leaf.id && prev.zone === zone
                  ? prev
                  : { leafId: leaf.id, zone }
              )
            }
            onDrop={(sid, zone, index) => {
              if (zone === 'center' && index >= 0) reorderTab(sid, leaf.id, index)
              else drop(sid, leaf.id, zone)
              setDragId(null)
              setOver(null)
            }}
          />
        ))}

        {handles.map((h, i) => (
          <div
            key={i}
            className={`split-handle ${h.dir}`}
            style={
              h.dir === 'row'
                ? { left: pct(h.rect.x), top: pct(h.rect.y), height: pct(h.rect.h) }
                : { left: pct(h.rect.x), top: pct(h.rect.y), width: pct(h.rect.w) }
            }
            onPointerDown={(e) => beginResize(e, h.splitId, h.index, h.dir, h.span)}
            onDoubleClick={(e) => {
              e.preventDefault()
              equalize()
            }}
          />
        ))}
      </div>
    </div>
  )
}

function PaneChrome({
  leaf,
  rect,
  isActive,
  sessions,
  dragId,
  canMerge,
  over,
  onNewTerminal,
  onToggleFocus,
  onTabClick,
  onTabClose,
  onRename,
  onMerge,
  onEqualize,
  onClosePane,
  onSplit,
  onMoveToNewGroup,
  onDragStart,
  onDragEnd,
  onZone,
  onDrop
}: {
  leaf: LeafNode
  rect: Rect
  isActive: boolean
  sessions: Map<string, Session>
  dragId: string | null
  canMerge: boolean
  over: DropZone | null
  onNewTerminal?: () => void
  onToggleFocus: (sid: string) => void
  onTabClick: (sid: string) => void
  onTabClose: (sid: string) => void
  onRename: (sid: string, title: string) => void
  onMerge: () => void
  onEqualize: () => void
  onClosePane: () => void
  onSplit: (sid: string, zone: DropZone) => void
  onMoveToNewGroup: (sid: string) => void
  onDragStart: (sid: string) => void
  onDragEnd: () => void
  onZone: (zone: DropZone) => void
  onDrop: (sid: string, zone: DropZone, index: number) => void
}) {
  const groupStyle: React.CSSProperties = {
    left: pct(rect.x),
    top: pct(rect.y),
    width: pct(rect.w),
    height: pct(rect.h)
  }

  // Tab overflow: the strip never shows a scrollbar; instead ‹ › chevrons appear
  // when the tabs don't fit, and scroll the list.
  const tabsRef = useRef<HTMLDivElement>(null)
  const [nav, setNav] = useState({ left: false, right: false })
  // Inline tab rename (double-click a tab title).
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null)
  // Right-click tab menu + pane overflow ("more") menu.
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; sid: string } | null>(null)
  const [moreMenu, setMoreMenu] = useState(false)
  const moreBtnRef = useRef<HTMLButtonElement>(null)
  const commitRename = (sid: string) => {
    const v = (editing?.value ?? '').trim()
    if (v) onRename(sid, v)
    setEditing(null)
  }
  const syncNav = useCallback(() => {
    const el = tabsRef.current
    if (!el) return
    const collapsed = el.clientWidth < 28
    setNav({
      left: !collapsed && el.scrollLeft > 1,
      right: !collapsed && el.scrollLeft + el.clientWidth < el.scrollWidth - 1
    })
  }, [])
  // Re-measure when the tab count changes; width changes are handled by the
  // ResizeObserver below. (Running this on every render forced a scroll-geometry
  // reflow per frame during drags/resizes.) Also keep the active tab visible —
  // Ctrl+Tab or a freshly opened tab must not sit off-screen behind the
  // chevrons with no visual cue.
  useEffect(() => {
    const strip = tabsRef.current
    if (strip) {
      const el = strip.querySelector<HTMLElement>('[aria-selected="true"]')
      if (el) {
        const left = el.offsetLeft
        const right = left + el.offsetWidth
        if (left < strip.scrollLeft) strip.scrollLeft = left
        else if (right > strip.scrollLeft + strip.clientWidth) {
          strip.scrollLeft = right - strip.clientWidth
        }
      }
    }
    syncNav()
  }, [leaf.tabs.length, leaf.active, syncNav])
  useEffect(() => {
    const el = tabsRef.current
    if (!el) return
    const ro = new ResizeObserver(syncNav)
    ro.observe(el)
    return () => ro.disconnect()
  }, [syncNav])
  const scrollTabs = (dir: number) =>
    tabsRef.current?.scrollBy({ left: dir * 160, behavior: 'smooth' })

  const activeSession = leaf.active ? (sessions.get(leaf.active) ?? null) : null
  const showAgentControls = activeSession?.kind === 'local' || activeSession?.kind === 'remote'

  return (
    <div className={`pane-group ${isActive ? 'active' : ''}`} style={groupStyle}>
      <div
        className="pane-tabstrip"
        style={{ height: TAB_H }}
        onDragOver={(e) => {
          if (!dragId) return
          e.preventDefault()
          onZone('center')
        }}
        onDrop={(e) => {
          // Dropping anywhere on the strip (not on a specific tab) merges the
          // dragged session into this pane as a trailing tab.
          e.preventDefault()
          const id = e.dataTransfer.getData('text/plain') || dragId
          if (id) onDrop(id, 'center', leaf.tabs.length)
        }}
      >
        {nav.left && (
          <button
            className="tab-nav"
            title="Scroll tabs left"
            onClick={(e) => {
              e.stopPropagation()
              scrollTabs(-1)
            }}
          >
            <IconChevronLeft size={12} />
          </button>
        )}
        <div
          className="pane-tabs"
          role="tablist"
          ref={tabsRef}
          onScroll={syncNav}
          onDoubleClick={(e) => {
            // Double-click on empty tab space opens the new-terminal picker.
            if (e.target === e.currentTarget) onNewTerminal?.()
          }}
        >
          {leaf.tabs.map((sid, i) => {
            const s = sessions.get(sid)
            if (!s) return null
            const label = deriveTabLabel(s)
            return (
              <div
                key={sid}
                role="tab"
                tabIndex={s.id === leaf.active ? 0 : -1}
                aria-selected={s.id === leaf.active}
                className={`tab ${s.id === leaf.active ? 'active' : ''} ${s.closed ? 'closed' : ''}`}
                draggable
                title={label.tooltip}
                onClick={() => onTabClick(sid)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  setCtxMenu({ x: e.clientX, y: e.clientY, sid })
                }}
                onKeyDown={(e) => {
                  // Only the tab itself — keys from the inline rename input
                  // (or the close button) must not re-activate it.
                  if (e.target !== e.currentTarget) return
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    onTabClick(sid)
                  }
                }}
                onDragStart={(e) => {
                  e.dataTransfer.setData('text/plain', sid)
                  e.dataTransfer.effectAllowed = 'move'
                  onDragStart(sid)
                }}
                onDragEnd={onDragEnd}
                onDragOver={(e) => {
                  if (!dragId) return
                  e.preventDefault()
                  onZone('center')
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  const id = e.dataTransfer.getData('text/plain') || dragId
                  if (id) onDrop(id, 'center', i)
                }}
              >
                <TabStatusDot sessionId={sid} />
                {s.agentOwnedBy && <span className="tab-agent-chip">AGT</span>}
                {s.exitCode != null && s.exitCode !== 0 && (
                  <span className="tab-exit-badge" title={`Exited with code ${s.exitCode}`}>
                    {s.exitCode}
                  </span>
                )}
                {editing?.id === sid ? (
                  <input
                    className="tab-rename"
                    autoFocus
                    value={editing?.value ?? ''}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => setEditing({ id: sid, value: e.target.value })}
                    onBlur={() => commitRename(sid)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        commitRename(sid)
                      } else if (e.key === 'Escape') {
                        e.preventDefault()
                        setEditing(null)
                      }
                    }}
                  />
                ) : (
                  <span
                    className="tab-title"
                    onDoubleClick={(e) => {
                      e.stopPropagation()
                      setEditing({ id: sid, value: label.title })
                    }}
                  >
                    <span className="tab-title-main">{label.title}</span>
                    {label.context && <span className="tab-title-context"> — {label.context}</span>}
                  </span>
                )}
                <button
                  className="tab-quick"
                  aria-label="Split right with a new terminal"
                  title="Split right with a new terminal"
                  onClick={(e) => {
                    e.stopPropagation()
                    onSplit(sid, 'right')
                  }}
                >
                  <IconSplit size={11} />
                </button>
                <button
                  className="tab-quick split-down"
                  aria-label="Split down with a new terminal"
                  title="Split down with a new terminal"
                  onClick={(e) => {
                    e.stopPropagation()
                    onSplit(sid, 'bottom')
                  }}
                >
                  <IconSplit size={11} />
                </button>
                <button
                  className="tab-close"
                  aria-label="Close tab"
                  onClick={(e) => {
                    e.stopPropagation()
                    onTabClose(sid)
                  }}
                >
                  <IconClose size={11} />
                </button>
              </div>
            )
          })}
        </div>
        {nav.right && (
          <button
            className="tab-nav"
            title="Scroll tabs right"
            onClick={(e) => {
              e.stopPropagation()
              scrollTabs(1)
            }}
          >
            <IconChevronRight size={12} />
          </button>
        )}
        {showAgentControls && activeSession && <PaneAgentControls session={activeSession} />}
        {activeSession?.kind === 'remote' && (
          <button
            className="pane-tmux"
            title="tmux sessions — Ctrl/Cmd+Alt+T"
            aria-label="tmux sessions"
            onClick={(e) => {
              e.stopPropagation()
              if (leaf.active) openTmuxPicker(leaf.active)
            }}
          >
            <IconTmux size={14} />
          </button>
        )}
        {leaf.active && (
          <button
            className="pane-focus"
            title="Focus (magnify) this terminal — Ctrl/Cmd+Shift+Z"
            aria-label="Focus this terminal"
            onClick={(e) => {
              e.stopPropagation()
              if (leaf.active) onToggleFocus(leaf.active)
            }}
          >
            <IconFocus size={14} />
          </button>
        )}
        {canMerge && (
          <button
            className="pane-merge"
            title="Merge this pane into the other pane"
            aria-label="Merge this pane"
            onClick={(e) => {
              e.stopPropagation()
              onMerge()
            }}
          >
            <IconMerge size={14} />
          </button>
        )}
        <button
          ref={moreBtnRef}
          className="pane-more"
          title="Pane actions (split, equalize, close)"
          aria-label="Pane actions"
          aria-haspopup="menu"
          aria-expanded={moreMenu}
          onClick={(e) => {
            e.stopPropagation()
            setMoreMenu((v) => !v)
          }}
        >
          <IconMore size={14} />
        </button>
        <button
          className="pane-add"
          title="New terminal (or double-click the tab bar)"
          aria-label="New terminal"
          onClick={(e) => {
            e.stopPropagation()
            onNewTerminal?.()
          }}
        >
          <IconPlus size={14} />
        </button>
      </div>

      {/* Body drop target — only intercepts the pointer while a drag is active. */}
      <div
        className="pane-dropzone"
        onDragOver={(e) => {
          if (!dragId) return
          e.preventDefault()
          const r = e.currentTarget.getBoundingClientRect()
          onZone(zoneAt(e.clientX - r.left, e.clientY - r.top, r.width, r.height))
        }}
        onDrop={(e) => {
          e.preventDefault()
          const id = e.dataTransfer.getData('text/plain') || dragId
          if (!id) return
          const r = e.currentTarget.getBoundingClientRect()
          onDrop(id, zoneAt(e.clientX - r.left, e.clientY - r.top, r.width, r.height), -1)
        }}
      >
        {over && <div className="drop-indicator" style={indicatorStyle(over)} />}
      </div>

      {ctxMenu && (
        <PopupMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          onClose={() => setCtxMenu(null)}
          items={[
            {
              label: 'Rename',
              onSelect: () => {
                const s = sessions.get(ctxMenu.sid)
                setEditing({ id: ctxMenu.sid, value: s ? deriveTabLabel(s).title : '' })
              }
            },
            { label: 'Split right', onSelect: () => onSplit(ctxMenu.sid, 'right') },
            { label: 'Split down', onSelect: () => onSplit(ctxMenu.sid, 'bottom') },
            { label: 'Move to new group', onSelect: () => onMoveToNewGroup(ctxMenu.sid) },
            { separator: true },
            { label: 'Close', onSelect: () => onTabClose(ctxMenu.sid) },
            {
              label: 'Close others',
              onSelect: () =>
                leaf.tabs.filter((t) => t !== ctxMenu.sid).forEach((t) => onTabClose(t))
            },
            {
              label: 'Close to the right',
              onSelect: () => {
                const i = leaf.tabs.indexOf(ctxMenu.sid)
                leaf.tabs.slice(i + 1).forEach((t) => onTabClose(t))
              }
            }
          ]}
        />
      )}
      {moreMenu && (
        <PopupMenu
          anchor={moreBtnRef.current}
          onClose={() => setMoreMenu(false)}
          items={[
            ...(leaf.active
              ? [
                  { label: 'Split right', onSelect: () => onSplit(leaf.active as string, 'right') },
                  { label: 'Split down', onSelect: () => onSplit(leaf.active as string, 'bottom') }
                ]
              : []),
            { label: 'Equalize panes', onSelect: onEqualize },
            ...(canMerge ? [{ label: 'Merge into other pane', onSelect: onMerge }] : []),
            { separator: true },
            {
              label: 'Rename tab',
              onSelect: () => {
                const active = leaf.active
                if (!active) return
                const s = sessions.get(active)
                setEditing({ id: active, value: s ? deriveTabLabel(s).title : '' })
              }
            },
            { label: 'Close pane', danger: true, onSelect: onClosePane }
          ]}
        />
      )}
    </div>
  )
}

interface PopupItem {
  label?: string
  separator?: boolean
  danger?: boolean
  onSelect?: () => void
}

/**
 * Small portal menu used by the pane "more" button and the tab context menu.
 * Positioned at (x, y) or under an anchor element; closes on outside click/Esc.
 */
function PopupMenu({
  x,
  y,
  anchor,
  items,
  onClose
}: {
  x?: number
  y?: number
  anchor?: HTMLElement | null
  items: PopupItem[]
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEscapeKey(onClose)
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (ref.current?.contains(t) || anchor?.contains(t)) return
      onClose()
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [anchor, onClose])

  const width = 200
  let left = x ?? 0
  let top = y ?? 0
  if (anchor) {
    const r = anchor.getBoundingClientRect()
    left = r.right - width
    top = r.bottom + 6
  }
  if (left < 8) left = 8
  const maxLeft = window.innerWidth - width - 8
  if (left > maxLeft) left = Math.max(8, maxLeft)
  if (top > window.innerHeight - 8) top = Math.max(8, window.innerHeight - 8)

  return createPortal(
    <div ref={ref} className="pane-menu" role="menu" style={{ top, left, width }}>
      {items.map((it, i) =>
        it.separator ? (
          <div key={i} className="pane-menu-sep" />
        ) : (
          <button
            key={i}
            type="button"
            role="menuitem"
            className={`pane-menu-item${it.danger ? ' is-danger' : ''}`}
            onClick={() => {
              it.onSelect?.()
              onClose()
            }}
          >
            {it.label}
          </button>
        )
      )}
    </div>,
    document.body
  )
}
