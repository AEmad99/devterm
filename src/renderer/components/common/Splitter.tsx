import { useCallback } from 'react'

/**
 * A draggable divider. `horizontal` resizes width (col-resize); `vertical`
 * resizes height (row-resize). Reports incremental pixel deltas to the parent,
 * which owns the size state.
 */
export default function Splitter({
  direction,
  onDelta
}: {
  direction: 'horizontal' | 'vertical'
  onDelta: (deltaPx: number) => void
}) {
  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      let last = direction === 'horizontal' ? e.clientX : e.clientY
      const move = (ev: MouseEvent) => {
        const cur = direction === 'horizontal' ? ev.clientX : ev.clientY
        onDelta(cur - last)
        last = cur
      }
      const up = () => {
        window.removeEventListener('mousemove', move)
        window.removeEventListener('mouseup', up)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }
      window.addEventListener('mousemove', move)
      window.addEventListener('mouseup', up)
      document.body.style.cursor = direction === 'horizontal' ? 'col-resize' : 'row-resize'
      document.body.style.userSelect = 'none'
    },
    [direction, onDelta]
  )

  return (
    <div
      className={`splitter splitter-${direction}`}
      role="separator"
      aria-orientation={direction === 'horizontal' ? 'vertical' : 'horizontal'}
      onMouseDown={onMouseDown}
    />
  )
}
