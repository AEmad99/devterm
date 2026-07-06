import type { SuggestView } from '../../lib/autosuggest'

/**
 * Cursor-anchored history-completion popup for a terminal pane. It only renders
 * (`view` non-null) while there's a live suggestion; the controller in
 * lib/autosuggest.ts owns all the logic. Rows use mousedown + preventDefault so
 * clicking a suggestion doesn't blur the terminal before the keystrokes are sent.
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
  if (!view) return null
  const { items, index, prefix, left, top, above } = view
  return (
    <div
      className="autosuggest"
      style={{ left, top, transform: above ? 'translateY(-100%)' : undefined }}
    >
      {items.map((cmd, i) => (
        <div
          key={cmd}
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
        <kbd>Tab</kbd>/<kbd>→</kbd> accept · <kbd>Esc</kbd> dismiss
      </div>
    </div>
  )
}
