// Toolbar microphone button for voice dictation. Reflects the dictation status
// (idle / loading / recording / transcribing / error) and toggles capture on
// click. Hidden entirely when dictation is disabled in settings.

import { IconMic } from '../common/Icons'
import { useDictation } from '../../store/dictation'
import { useSettings } from '../../store/settings'
import { dictation } from '../../lib/stt/dictation'

interface MicButtonProps {
  /** Human-readable hotkey label, e.g. "Ctrl+Shift+M". */
  hotkey?: string
}

export default function MicButton({ hotkey }: MicButtonProps) {
  const enabled = useSettings((s) => s.stt.enabled)
  const { status, progress, backend, error } = useDictation()

  if (!enabled) return null

  const recording = status === 'recording'
  const busy = status === 'loading' || status === 'transcribing' || status === 'requesting-mic'

  let title: string
  switch (status) {
    case 'recording':
      title = 'Stop dictation and transcribe'
      break
    case 'loading':
      title =
        progress != null
          ? `Downloading speech model… ${Math.round(progress * 100)}%`
          : 'Loading speech model…'
      break
    case 'transcribing':
      title = 'Transcribing…'
      break
    case 'requesting-mic':
      title = 'Waiting for microphone…'
      break
    case 'error':
      title = error ?? 'Dictation error'
      break
    default:
      title =
        (hotkey ? `Dictate (${hotkey})` : 'Dictate') +
        (backend ? ` · ${backend === 'webgpu' ? 'GPU' : 'CPU'}` : '')
  }

  const cls = [
    'settings-btn',
    'mic-btn',
    recording ? 'recording' : '',
    busy ? 'busy' : '',
    status === 'error' ? 'error' : ''
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <button
      className={cls}
      title={title}
      aria-pressed={recording}
      aria-label="Voice dictation"
      onClick={() => void dictation.toggle()}
    >
      <IconMic size={17} />
    </button>
  )
}
