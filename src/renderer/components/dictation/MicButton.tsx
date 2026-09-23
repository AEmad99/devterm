// Sidebar microphone button for voice dictation. Reflects the dictation status
// (idle / loading / recording / transcribing / error) and toggles capture on
// click. Hidden entirely when dictation is disabled in settings.

import { IconMic } from '../common/Icons'
import Button from '../common/Button'
import Tooltip, { type TooltipPos } from '../common/Tooltip'
import { useDictation } from '../../store/dictation'
import { useSettings } from '../../store/settings'
import { dictation } from '../../lib/stt/dictation'

interface MicButtonProps {
  /** Human-readable hotkey label, e.g. "Ctrl+Shift+M". */
  hotkey?: string
  /** Tooltip placement. The sidebar rail opens tips to the right. */
  pos?: TooltipPos
}

export default function MicButton({ hotkey, pos = 'right' }: MicButtonProps) {
  const enabled = useSettings((s) => s.stt.enabled)
  const { status, progress, backend, error } = useDictation()

  if (!enabled) return null

  const recording = status === 'recording'
  const busy = status === 'loading' || status === 'transcribing' || status === 'requesting-mic'

  let tip: string
  switch (status) {
    case 'recording':
      tip = 'Stop dictation and transcribe'
      break
    case 'loading':
      tip =
        progress != null
          ? `Downloading speech model… ${Math.round(progress * 100)}%`
          : 'Loading speech model…'
      break
    case 'transcribing':
      tip = 'Transcribing…'
      break
    case 'requesting-mic':
      tip = 'Waiting for microphone…'
      break
    case 'error':
      tip = error ?? 'Dictation error'
      break
    default:
      tip = 'Dictate' + (backend ? ` · ${backend === 'webgpu' ? 'GPU' : 'CPU'}` : '')
  }

  const cls = [
    'mic-btn',
    recording ? 'recording' : '',
    busy ? 'busy' : '',
    status === 'error' ? 'error' : ''
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <Tooltip tip={tip} hotkey={status === 'idle' ? hotkey : undefined} pos={pos}>
      <Button
        variant="icon"
        className={cls}
        active={recording}
        aria-label="Voice dictation"
        onClick={() => void dictation.toggle()}
      >
        <IconMic size={17} />
      </Button>
    </Tooltip>
  )
}
