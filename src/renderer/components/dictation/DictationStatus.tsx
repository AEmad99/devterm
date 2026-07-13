// Floating dictation status pill. Shows model-download progress, recording, and
// transcribing states in a corner so the user has feedback even when the toolbar
// is hidden (zen mode). Idle produces no chrome. Respects the user's
// showFloatingStatus preference.

import { useDictation } from '../../store/dictation'
import { useSettings } from '../../store/settings'
import { dictation } from '../../lib/stt/dictation'

export default function DictationStatus() {
  const show = useSettings((s) => s.stt.showFloatingStatus)
  const { status, progress, error } = useDictation()

  if (!show) return null
  if (status === 'idle') return null

  let label: string
  let action: { text: string; onClick: () => void } | null = null
  switch (status) {
    case 'loading':
      label = progress != null ? `Downloading model ${Math.round(progress * 100)}%` : 'Loading model…'
      break
    case 'requesting-mic':
      label = 'Allow microphone…'
      break
    case 'recording':
      label = 'Recording — click to stop'
      action = { text: 'Stop', onClick: () => void dictation.stop() }
      break
    case 'transcribing':
      label = 'Transcribing…'
      break
    case 'error':
      label = error ?? 'Dictation error'
      break
    default:
      label = ''
  }

  return (
    <div className="dictation-status-wrap" aria-live="polite">
      <div className={`dictation-status status-${status}`}>
        <span className="dictation-dot" />
        <span className="dictation-label">{label}</span>
        {action && (
          <button className="dictation-action" onClick={action.onClick}>
            {action.text}
          </button>
        )}
      </div>
    </div>
  )
}
