import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { AgentKind, AgentUiMode } from '@shared/types'
import type { Session } from '../../store/sessions'
import { useSessions } from '../../store/sessions'
import { useSettings } from '../../store/settings'
import {
  AGENT_KIND_MENU,
  agentKindGlyph,
  agentKindLabel,
  restartAgent,
  setAgentUiMode,
  stopAgent
} from '../../lib/agent-ui'
import { agentKindIcon } from '../../lib/agent-icons'
import { useEscapeKey } from '../../lib/useEscapeKey'
import Tooltip from '../common/Tooltip'
import {
  IconAgent,
  IconAgentFloat,
  IconAgentHide,
  IconAgentShow,
  IconAgentStop,
  IconChevron,
  IconEye,
  IconRefresh
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

  const label = agentKindLabel(kind)
  const pending = !!session.agentPendingApproval

  const onReview = useCallback(() => {
    // Bring the agent into view (docked) and open the activity panel so the
    // operator sees what the agent is waiting on. The approval modal itself
    // renders globally when the request is not snoozed.
    const settings = useSettings.getState()
    settings.setTransfersPanelOpen(false)
    settings.setAgentActivityCollapsed(false)
    void setAgentUiMode(session.id, 'docked', { kind, title: hostTitle })
  }, [session.id, kind, hostTitle])

  const launchTip = !canStart
    ? session.kind === 'remote'
      ? 'Connect the SSH session first'
      : 'This terminal is closed'
    : `Open ${label}`
  const statusTip =
    agentUiMode === 'floating'
      ? `${label} is in a floating window`
      : agentUiMode === 'hidden'
        ? `${label} is running hidden`
        : `${label} is running`

  const MODES: { id: AgentUiMode; tip: string; icon: typeof IconAgentShow }[] = [
    { id: 'docked', tip: 'Dock the agent into this pane', icon: IconAgentShow },
    { id: 'hidden', tip: 'Hide the agent; keep it running', icon: IconAgentHide },
    { id: 'floating', tip: 'Pop the agent out into a floating window', icon: IconAgentFloat }
  ]

  return (
    <div
      className={`pane-agent${agentAlive ? ' is-live' : ''}${pending ? ' has-pending' : ''}`}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      {!agentAlive ? (
        <div className="pane-agent-launch">
          <Tooltip tip={launchTip} pos="bottom">
            <button
              type="button"
              className="pane-agent-open"
              disabled={!canStart}
              aria-label={launchTip}
              onClick={startDocked}
            >
              <IconAgent size={14} />
            </button>
          </Tooltip>
          <Tooltip tip={`${label} — click to switch agent`} pos="bottom">
            <button
              ref={kindBtnRef}
              type="button"
              className="pane-agent-kind"
              disabled={!canStart}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-label={`${label} — click to switch agent`}
              onClick={() => setMenuOpen((v) => !v)}
            >
              <KindMark kind={kind} />
              <IconChevron size={10} />
            </button>
          </Tooltip>
        </div>
      ) : (
        <div className="pane-agent-live">
          <Tooltip tip={statusTip} pos="bottom">
            <span className="pane-agent-status">
              <IconAgent size={14} />
              <KindMark kind={kind} />
            </span>
          </Tooltip>
          {pending && (
            <Tooltip tip="Review the pending approval request" pos="bottom">
              <button
                type="button"
                className="pane-agent-btn pane-agent-review"
                aria-label="Review the pending approval request"
                onClick={onReview}
              >
                <IconEye size={14} />
              </button>
            </Tooltip>
          )}
          <div className="pane-agent-seg" role="group" aria-label="Agent placement">
            {MODES.map((m) => {
              const Icon = m.icon
              return (
                <Tooltip key={m.id} tip={m.tip} pos="bottom">
                  <button
                    type="button"
                    className={`pane-agent-btn seg${agentUiMode === m.id ? ' active' : ''}`}
                    aria-label={m.tip}
                    aria-pressed={agentUiMode === m.id}
                    onClick={() =>
                      void setAgentUiMode(session.id, m.id, { kind, title: hostTitle })
                    }
                  >
                    <Icon size={13} />
                  </button>
                </Tooltip>
              )
            })}
          </div>
          <Tooltip tip={`Restart ${label} (fresh process + bridge)`} pos="bottom">
            <button
              type="button"
              className="pane-agent-btn"
              aria-label={`Restart ${label}`}
              onClick={() => restartAgent(session.id)}
            >
              <IconRefresh size={13} />
            </button>
          </Tooltip>
          <Tooltip tip={`Stop ${label}`} pos="bottom">
            <button
              type="button"
              className="pane-agent-btn pane-agent-stop"
              aria-label={`Stop ${label}`}
              onClick={onStop}
            >
              <IconAgentStop size={12} />
            </button>
          </Tooltip>
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
