import { useEffect, useRef, useState } from 'react'
import { tokenizeShell, type ShellDialect } from '../../lib/shell-highlight'

/**
 * One-line highlighted command editor shown only when OSC 133 hooks are healthy.
 * Accepting sends keystrokes to the shell; nothing is written into the xterm buffer.
 */
export default function CommandInput({
  visible,
  dialect,
  focusToken,
  autoFocus,
  onSubmit,
  onPassToShell,
  onEscape
}: {
  visible: boolean
  dialect: ShellDialect
  focusToken: number
  autoFocus: boolean
  onSubmit: (command: string) => void
  onPassToShell: (data: string) => void
  onEscape: () => void
}) {
  const fieldRef = useRef<HTMLTextAreaElement>(null)
  const [value, setValue] = useState('')

  useEffect(() => {
    if (!visible) {
      setValue('')
      return
    }
    if (!autoFocus) return
    fieldRef.current?.focus()
  }, [visible, focusToken, autoFocus])

  if (!visible) return null

  const tokens = tokenizeShell(value, dialect)

  return (
    <div className="cmd-input-bar">
      <div className="cmd-input-prompt" aria-hidden="true">
        ›
      </div>
      <div className="cmd-input-editor">
        <pre className="cmd-input-hl" aria-hidden="true">
          {tokens.map((t, i) => (
            <span key={i} className={`sh-${t.kind}`}>
              {t.text}
            </span>
          ))}
        </pre>
        <textarea
          ref={fieldRef}
          className="cmd-input-field"
          rows={1}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          aria-label="Command input"
          placeholder="Command"
          value={value}
          onChange={(e) => setValue(e.target.value.replace(/[\r\n]/g, ''))}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
              e.preventDefault()
              const command = value
              setValue('')
              onSubmit(command)
              return
            }
            if (e.key === 'Escape') {
              e.preventDefault()
              onEscape()
              return
            }
            if (e.key === 'ArrowUp' && !value) {
              e.preventDefault()
              onPassToShell('\x1b[A')
              onEscape()
              return
            }
            if (e.key === 'r' && e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
              e.preventDefault()
              onPassToShell('\x12')
              onEscape()
              return
            }
            if (
              (e.key === 'c' || e.key === 'C') &&
              e.ctrlKey &&
              !e.altKey &&
              !e.metaKey &&
              !e.shiftKey
            ) {
              if (e.currentTarget.selectionStart !== e.currentTarget.selectionEnd) return
              e.preventDefault()
              setValue('')
              onPassToShell('\x03')
            }
          }}
        />
      </div>
    </div>
  )
}
