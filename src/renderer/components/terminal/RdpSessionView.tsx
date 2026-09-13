import type { Session } from '../../store/sessions'
import Button from '../common/Button'

export default function RdpSessionView({ session }: { session: Session }) {
  return (
    <div className="rdp-pane">
      <div className="rdp-card">
        <div className="rdp-kicker">Remote Desktop</div>
        <h3>{session.title}</h3>
        <p className="rdp-status">{session.status || 'RDP session'}</p>
        <p className="rdp-copy">
          The Windows desktop opens in Microsoft Remote Desktop. To let a DevTerm Agent run
          commands on this machine, connect with OpenSSH instead (or in addition) — RDP is the
          graphical session only.
        </p>
        <div className="rdp-actions">
          <Button variant="primary" onClick={() => window.devterm.rdp.focus(session.id)}>
            Focus desktop
          </Button>
        </div>
      </div>
    </div>
  )
}

