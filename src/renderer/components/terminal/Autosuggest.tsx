import { useEffect, useRef } from 'react'
import type { SuggestView } from '../../lib/autosuggest'

/**
 * Cursor-anchored history-completion popup for a terminal pane. It only renders
 * (`view` non-null) while there's a live suggestion; the controller in
 * lib/autosuggest.ts owns all the logic. Rows use mousedown + preventDefault so
 * clicking a suggestion doesn't blur the terminal before the keystrokes are sent.
 * The box floats above/below the prompt line (never over it) and caps its
 * height with a scroll so it can't bury the typed input.
 */
export default function Autosuggest({
  view,
  onAccept,
  onHover
}: {
  view: SuggestView | null
  onAccept: (i: number) => void
  onHover: (i: number) => void
}) {
  const boxRef = useRef<HTMLDivElement>(null)
  // Keep the keyboard-selected row visible while walking with ↑/↓.
  useEffect(() => {
    if (!view) return
    boxRef.current?.querySelector('.as-row.sel')?.scrollIntoView({ block: 'nearest' })
  }, [view])
  if (!view) return null
  const { items, index, prefix, left, top, above } = view
  return (
    <div
      ref={boxRef}
      className="autosuggest"
      role="listbox"
      aria-label="Command history suggestions"
      style={{ left, top, transform: above ? 'translateY(-100%)' : undefined }}
    >
      {items.map((cmd, i) => (
        <div
          key={cmd}
          role="option"
          aria-selected={i === index}
          className={`as-row ${i === index ? 'sel' : ''}`}
          onMouseEnter={() => onHover(i)}
          onMouseDown={(e) => {
            e.preventDefault()
            onAccept(i)
          }}
        >
          <span className="as-typed">{prefix}</span>
          <span className="as-rest">{cmd.slice(prefix.length)}</span>
        </div>
      ))}
      <div className="as-hint">
        <kbd>↑</kbd>
        <kbd>↓</kbd> choose · <kbd>Tab</kbd>/<kbd>→</kbd> accept · <kbd>Esc</kbd> shell history
      </div>
    </div>
  )
}
