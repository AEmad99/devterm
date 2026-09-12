import { useToasts, type ToastTone } from '../../store/toasts'

const TONE_CLASS: Record<ToastTone, string> = {
  info: '',
  ok: 'tone-ok',
  err: 'tone-err'
}

/**
 * Bottom-right transient confirmations. Stacks above the status bar; each
 * toast auto-dismisses after a few seconds or on click.
 */
export default function Toasts() {
  const toasts = useToasts((s) => s.toasts)
  const dismiss = useToasts((s) => s.dismiss)
  if (toasts.length === 0) return null
  return (
    <div className="toast-stack" aria-live="polite">
      {toasts.map((t) => (
        <button
          key={t.id}
          type="button"
          className={`toast ${TONE_CLASS[t.tone]}`}
          onClick={() => dismiss(t.id)}
          title="Dismiss"
        >
          {t.message}
        </button>
      ))}
    </div>
  )
}
