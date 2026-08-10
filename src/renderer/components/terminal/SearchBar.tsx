import { useEffect, useRef, useState } from 'react'

/**
 * Per-terminal find bar (Ctrl/Cmd+Shift+F). Drives xterm's SearchAddon via the
 * `onSearch` callback (dir +1 = next, -1 = previous). Renders as an overlay in
 * the top-right of the terminal pane.
 */
export default function SearchBar({
  onSearch,
  onClose,
  focusToken = 0
}: {
  onSearch: (query: string, dir: number) => void
  onClose: () => void
  /** Increment to re-focus the input when Find is pressed again while open. */
  focusToken?: number
}) {
  const [q, setQ] = useState('')
  const ref = useRef<HTMLInputElement>(null)

  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [focusToken])

  return (
    <div className="term-search" onMouseDown={(e) => e.stopPropagation()}>
      <input
        ref={ref}
        className="term-search-input"
        value={q}
        placeholder="Find"
        spellCheck={false}
        onChange={(e) => {
          setQ(e.target.value)
          onSearch(e.target.value, 1)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            onSearch(q, e.shiftKey ? -1 : 1)
          } else if (e.key === 'Escape') {
            e.preventDefault()
            onClose()
          }
        }}
      />
      <button
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => onSearch(q, -1)}
        title="Previous (Shift+Enter)"
      >
        ↑
      </button>
      <button
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => onSearch(q, 1)}
        title="Next (Enter)"
      >
        ↓
      </button>
      <button onMouseDown={(e) => e.preventDefault()} onClick={onClose} title="Close (Esc)">
        ×
      </button>
    </div>
  )
}
