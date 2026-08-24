import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { AgentKind } from '@shared/types'
import type { Session } from '../../store/sessions'
import { useSessions } from '../../store/sessions'
import { useSettings } from '../../store/settings'
import {
  AGENT_KIND_MENU,
  agentKindGlyph,
  agentKindLabel,
  setAgentUiMode,
  stopAgent
} from '../../lib/agent-ui'
import { agentKindIcon } from '../../lib/agent-icons'
import { useEscapeKey } from '../../lib/useEscapeKey'
import {
  IconAgent,
  IconAgentFloat,
  IconAgentHide,
  IconAgentShow,
  IconAgentStop,
  IconChevron
} from '../common/Icons'

/** Brand icon chip for an agent kind; falls back to the letter glyph. */
function KindMark({ kind }: { kind: AgentKind }) {
  const icon = agentKindIcon(kind)
  return (
    <span className="pane-agent-glyph">
      {icon ? (
        <img className="pane-agent-glyph-img" src={icon} alt="" draggable={false} />
      ) : (
        agentKindGlyph(kind)
      )}
    </span>
  )
}

/**
 * Compact icon cluster on the pane tab strip: sparkle + kind mark to launch,
 * hide / float / stop once the agent is alive. Replaces the old text header
 * (AGENT <select> Hide Float Stop).
 */
export default function PaneAgentControls({ session }: { session: Session }) {
  const persistAgentKind = useSettings((s) => s.setAgentKind)
  const settingsKind = useSettings((s) => s.agentKind)
  const setAgentUi = useSessions((s) => s.setAgentUi)
  const kind = session.agentKind ?? settingsKind
  const agentUiMode = session.agentUiMode
  const agentAlive = !!agentUiMode
  const canStart = !session.closed && (session.kind === 'local' || !!session.context)
  const hostTitle = session.context?.hostname ?? session.title
  const [menuOpen, setMenuOpen] = useState(false)
  const kindBtnRef = useRef<HTMLButtonElement>(null)

  const pickKind = useCallback(
    (next: AgentKind) => {
      persistAgentKind(next)
      setAgentUi(session.id, { kind: next })
      setMenuOpen(false)
    },
    [persistAgentKind, setAgentUi, session.id]
  )

  const startDocked = useCallback(() => {
    if (!canStart) return
    void setAgentUiMode(session.id, 'docked', { kind, title: hostTitle })
  }, [canStart, session.id, kind, hostTitle])

  const onStop = useCallback(() => {
    stopAgent(session.id)
  }, [session.id])

  const onHide = useCallback(() => {
    void setAgentUiMode(session.id, 'hidden', { kind })
  }, [session.id, kind])

  const onDock = useCallback(() => {
    void setAgentUiMode(session.id, 'docked', { kind, title: hostTitle })
  }, [session.id, kind, hostTitle])

  const onFloat = useCallback(() => {
    void setAgentUiMode(session.id, 'floating', { kind, title: hostTitle })
  }, [session.id, kind, hostTitle])

  const label = agentKindLabel(kind)
  const pending = !!session.agentPendingApproval

  return (
    <div
      className={`pane-agent${agentAlive ? ' is-live' : ''}${pending ? ' has-pending' : ''}`}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      {!agentAlive ? (
        <div className="pane-agent-launch">
          <button
            type="button"
            className="pane-agent-open"
            disabled={!canStart}
            title={
              !canStart
                ? session.kind === 'remote'
                  ? 'Connect the SSH session first'
                  : 'This terminal is closed'
                : `Open ${label}`
            }
            onClick={startDocked}
          >
            <IconAgent size={14} />
          </button>
          <button
            ref={kindBtnRef}
            type="button"
            className="pane-agent-kind"
            disabled={!canStart}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            title={`${label} — click to switch agent`}
            onClick={() => setMenuOpen((v) => !v)}
          >
            <KindMark kind={kind} />
            <IconChevron size={10} />
          </button>
        </div>
      ) : (
        <div className="pane-agent-live">
          <span
            className="pane-agent-status"
            title={
              agentUiMode === 'floating'
                ? `${label} is in a floating window`
                : agentUiMode === 'hidden'
                  ? `${label} is running hidden`
                  : `${label} is running`
            }
          >
            <IconAgent size={14} />
            <KindMark kind={kind} />
          </span>
          {agentUiMode === 'docked' ? (
            <button
              type="button"
              className="pane-agent-btn"
              title="Hide the agent; keep it running"
              onClick={onHide}
            >
              <IconAgentHide size={14} />
            </button>
          ) : (
            <button
              type="button"
              className="pane-agent-btn"
              title={
                agentUiMode === 'floating'
                  ? 'Dock the agent back into this pane'
                  : 'Show the agent in this pane'
              }
              onClick={onDock}
            >
              <IconAgentShow size={14} />
            </button>
          )}
          {agentUiMode !== 'floating' && (
            <button
              type="button"
              className="pane-agent-btn"
              title="Pop the agent out into a floating window"
              onClick={onFloat}
            >
              <IconAgentFloat size={14} />
            </button>
          )}
          <button
            type="button"
            className="pane-agent-btn pane-agent-stop"
            title={`Stop ${label}`}
            onClick={onStop}
          >
            <IconAgentStop size={12} />
            {pending && <span className="pane-agent-pending" />}
          </button>
        </div>
      )}
      {menuOpen && (
        <KindMenu
          anchor={kindBtnRef.current}
          selected={kind}
          onPick={pickKind}
          onClose={() => setMenuOpen(false)}
        />
      )}
    </div>
  )
}

function KindMenu({
  anchor,
  selected,
  onPick,
  onClose
}: {
  anchor: HTMLElement | null
  selected: AgentKind
  onPick: (kind: AgentKind) => void
  onClose: () => void
}) {
  const menuRef = useRef<HTMLDivElement>(null)
  useEscapeKey(onClose)

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (menuRef.current?.contains(t) || anchor?.contains(t)) return
      onClose()
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [anchor, onClose])

  if (!anchor) return null
  const r = anchor.getBoundingClientRect()
  const width = 196
  let left = r.right - width
  if (left < 8) left = r.left
  const maxLeft = window.innerWidth - width - 8
  if (left > maxLeft) left = Math.max(8, maxLeft)

  return createPortal(
    <div ref={menuRef} className="pane-agent-menu" role="menu" style={{ top: r.bottom + 6, left }}>
      {AGENT_KIND_MENU.map((group) => (
        <div key={group.group} className="pane-agent-menu-group">
          <div className="pane-agent-menu-label">{group.group}</div>
          {group.kinds.map((k) => (
            <button
              key={k}
              type="button"
              role="menuitemradio"
              aria-checked={k === selected}
              className={`pane-agent-menu-item${k === selected ? ' is-selected' : ''}`}
              onClick={() => onPick(k)}
            >
              <KindMark kind={k} />
              <span className="pane-agent-menu-name">{agentKindLabel(k)}</span>
            </button>
          ))}
        </div>
      ))}
    </div>,
    document.body
  )
}
