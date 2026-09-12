import type { ReactNode } from 'react'

export type TooltipPos = 'top' | 'bottom' | 'left' | 'right'

interface TooltipProps {
  /** Plain-text tooltip body. Rendered by CSS from `data-tip` — no markup. */
  tip: string
  /** Optional hotkey label appended to the tip, e.g. "Ctrl+K". */
  hotkey?: string
  /** Placement of the bubble relative to the anchor. Defaults to `top`. */
  pos?: TooltipPos
  /** Extra class on the wrapper (e.g. to keep flex layout). */
  className?: string
  children: ReactNode
}

/**
 * House tooltip. A CSS-only bubble (`[data-tip]` in chrome.css) that replaces
 * native `title=` tooltips on icon buttons: theme-aware, instant, and able to
 * show the hotkey. The anchor keeps its own `aria-label` for screen readers —
 * the bubble is `aria-hidden` by construction (CSS content).
 *
 * Prefer wrapping the control rather than sprinkling `data-tip` by hand so
 * the hotkey formatting stays consistent.
 */
export default function Tooltip({
  tip,
  hotkey,
  pos = 'top',
  className = '',
  children
}: TooltipProps) {
  return (
    <span
      className={`tip-anchor ${className}`.trim()}
      data-tip={tip}
      data-tip-pos={pos}
      data-hotkey={hotkey || undefined}
    >
      {children}
    </span>
  )
}
