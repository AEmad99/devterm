/**
 * Shared debounce helpers for the renderer.
 *
 * `useDebouncedCallback` returns a stable function that delays invocation of
 * the latest args by `wait` ms. It automatically cancels on unmount and exposes
 * `cancel()` for explicit cleanup.
 */
import { useRef, useEffect, useCallback } from 'react'

export function useDebouncedCallback<T extends (...args: Parameters<T>) => void>(
  fn: T,
  wait: number
): T & { cancel(): void } {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fnRef = useRef(fn)
  fnRef.current = fn

  const cancel = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  useEffect(() => cancel, [cancel])

  const debounced = useCallback(
    ((...args: Parameters<T>) => {
      cancel()
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        fnRef.current(...args)
      }, wait)
    }) as T,
    [cancel, wait]
  )

  return Object.assign(debounced, { cancel })
}
