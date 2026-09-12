import { IconActivity, IconClose, IconTransfer } from '../common/Icons'
import Tooltip from '../common/Tooltip'
import { useSessions } from '../../store/sessions'
import { useTransfers } from '../../store/transfers'
import type { BottomPanelMode } from './types'

interface BottomPanelToggleProps {
  mode: BottomPanelMode
  setMode: (mode: BottomPanelMode) => void
}

const MODES: {
  id: BottomPanelMode
  label: string
  tip: string
  icon: typeof IconActivity
}[] = [
  {
    id: 'activity',
    label: 'Activity',
    tip: 'Show the agent activity panel',
    icon: IconActivity
  },
  {
    id: 'transfers',
    label: 'Transfers',
    tip: 'Show the transfers panel',
    icon: IconTransfer
  },
  { id: 'off', label: 'Off', tip: 'Hide the bottom dock', icon: IconClose }
]

export default function BottomPanelToggle({ mode, setMode }: BottomPanelToggleProps) {
  // Badge counts: sessions awaiting an approval decision, and in-flight
  // transfers. Zero renders no badge.
  const pendingApprovals = useSessions(
    (s) => s.sessions.filter((x) => x.agentPendingApproval).length
  )
  const runningTransfers = useTransfers((s) => s.items.filter((it) => !it.done).length)

  const badgeFor = (id: BottomPanelMode): number =>
    id === 'activity' ? pendingApprovals : id === 'transfers' ? runningTransfers : 0

  return (
    <div className="bottom-panel-toggle" role="group" aria-label="Bottom panel">
      {MODES.map((m) => {
        const Icon = m.icon
        const badge = badgeFor(m.id)
        return (
          <Tooltip key={m.id} tip={m.tip} pos="bottom">
            <button
              type="button"
              aria-pressed={mode === m.id}
              aria-label={`${m.tip}${badge > 0 ? ` (${badge} pending)` : ''}`}
              className={`seg ${mode === m.id ? 'active' : ''} ${badge > 0 ? 'has-badge' : ''}`}
              onClick={() => setMode(m.id)}
            >
              <Icon size={14} />
              <span className="seg-label">{m.label}</span>
              {badge > 0 && (
                <span
                  className={`seg-badge ${m.id === 'activity' ? 'warn' : ''}`}
                  aria-hidden="true"
                >
                  {badge > 99 ? '99+' : badge}
                </span>
              )}
            </button>
          </Tooltip>
        )
      })}
    </div>
  )
}
