import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import TerminalView from './TerminalView'
import RemoteSessionView from './RemoteSessionView'
import BrowserPane from './BrowserPane'
import { useSessions, type Session } from '../store/sessions'
import { useEditors } from '../store/editors'
import { useLayout, computeLayout, type DropZone, type LeafNode, type Rect } from '../store/layout'
import { IconMerge, IconPlus } from './Icons'

const TAB_H = 30 // px height of a pane's tab strip

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
  onNewTerminal
}: {
  sessions: Session[]
  onNewTerminal?: () => void
}) {
  // The active group's tree drives the panes/chrome; sessions in other groups
  // still render in the term-layer (hidden) so their PTYs/shells stay alive.
  const root = useLayout((s) => s.groups.find((g) => g.id === s.activeGroupId)?.root ?? null)
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
  const setSessionActive = useSessions((s) => s.setActive)
  const setTitle = useSessions((s) => s.setTitle)
  const close = useSessions((s) => s.close)
  const editorBlur = useEditors((s) => s.blur)
  const editorCloseForSession = useEditors((s) => s.closeForSession)

  const panesRef = useRef<HTMLDivElement>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [over, setOver] = useState<{ leafId: string; zone: DropZone } | null>(null)

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

  const byId = useMemo(() => new Map(sessions.map((s) => [s.id, s])), [sessions])
  const { leaves, handles } = useMemo(() => computeLayout(root), [root])
  // sessionId -> the leaf that currently owns it (for focus-on-click).
  const leafOfSession = useMemo(() => {
    const m = new Map<string, string>()
    leaves.forEach(({ leaf }) => leaf.tabs.forEach((t) => m.set(t, leaf.id)))
    return m
  }, [leaves])

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

  // --- splitter drag (pointer-based) ---
  const beginResize = (
    e: React.PointerEvent,
    splitId: string,
    index: number,
    dir: 'row' | 'col'
  ) => {
    e.preventDefault()
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
    const box = panesRef.current?.getBoundingClientRect()
    const span = dir === 'row' ? (box?.width ?? 1) : (box?.height ?? 1)
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
      el.releasePointerCapture(e.pointerId)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const slotBodyStyle = (rect: Rect): React.CSSProperties => ({
    left: pct(rect.x),
    top: `calc(${pct(rect.y)} + ${TAB_H}px)`,
    width: pct(rect.w),
    height: `calc(${pct(rect.h)} - ${TAB_H}px)`
  })

  return (
    <div className={`panes tiling ${dragId ? 'dragging' : ''}`} ref={panesRef}>
      {/* Layer 1: terminals — one stable slot per session, never reparented. */}
      <div className="term-layer">
        {sessions.map((s) => {
          const leafId = leafOfSession.get(s.id)
          const entry = leaves.find((l) => l.leaf.id === leafId)
          const visible = !!entry && entry.leaf.active === s.id
          const rect = entry?.rect ?? { x: 0, y: 0, w: 1, h: 1 }
          return (
            <div
              key={s.id}
              className="term-slot"
              style={{ ...slotBodyStyle(rect), display: visible ? 'block' : 'none' }}
              onMouseDownCapture={() => focusSession(s.id)}
            >
              {s.kind === 'browser' ? (
                <BrowserPane session={s} />
              ) : s.kind === 'remote' ? (
                <RemoteSessionView session={s} />
              ) : (
                <TerminalView session={s} />
              )}
            </div>
          )
        })}
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
            onTabClick={focusSession}
            onTabClose={closeSession}
            onRename={setTitle}
            onMerge={() => mergeLeaf(leaf.id)}
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
            onPointerDown={(e) => beginResize(e, h.splitId, h.index, h.dir)}
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
  onTabClick,
  onTabClose,
  onRename,
  onMerge,
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
  onTabClick: (sid: string) => void
  onTabClose: (sid: string) => void
  onRename: (sid: string, title: string) => void
  onMerge: () => void
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
  const commitRename = (sid: string) => {
    const v = (editing?.value ?? '').trim()
    if (v) onRename(sid, v)
    setEditing(null)
  }
  const syncNav = useCallback(() => {
    const el = tabsRef.current
    if (!el) return
    setNav({
      left: el.scrollLeft > 1,
      right: el.scrollLeft + el.clientWidth < el.scrollWidth - 1
    })
  }, [])
  // Re-measure when the tab count changes; width changes are handled by the
  // ResizeObserver below. (Running this on every render forced a scroll-geometry
  // reflow per frame during drags/resizes.)
  useEffect(syncNav, [leaf.tabs.length, syncNav])
  useEffect(() => {
    const el = tabsRef.current
    if (!el) return
    const ro = new ResizeObserver(syncNav)
    ro.observe(el)
    return () => ro.disconnect()
  }, [syncNav])
  const scrollTabs = (dir: number) =>
    tabsRef.current?.scrollBy({ left: dir * 160, behavior: 'smooth' })

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
            ‹
          </button>
        )}
        <div
          className="pane-tabs"
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
            return (
              <div
                key={sid}
                className={`tab ${s.id === leaf.active ? 'active' : ''} ${s.closed ? 'closed' : ''}`}
                draggable
                onClick={() => onTabClick(sid)}
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
                <span className="dot" data-kind={s.kind} />
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
                    title="Double-click to rename"
                    onDoubleClick={(e) => {
                      e.stopPropagation()
                      setEditing({ id: sid, value: s.title })
                    }}
                  >
                    {s.title}
                  </span>
                )}
                <span
                  className="tab-close"
                  onClick={(e) => {
                    e.stopPropagation()
                    onTabClose(sid)
                  }}
                >
                  ×
                </span>
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
            ›
          </button>
        )}
        {canMerge && (
          <button
            className="pane-merge"
            title="Merge this pane into the other pane"
            onClick={(e) => {
              e.stopPropagation()
              onMerge()
            }}
          >
            <IconMerge size={14} />
          </button>
        )}
        <button
          className="pane-add"
          title="New terminal (or double-click the tab bar)"
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
    </div>
  )
}
