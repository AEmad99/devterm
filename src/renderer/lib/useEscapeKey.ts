import { useEffect } from 'react'

/**
 * Close a modal/popover on Escape, regardless of where focus sits inside it.
 * Matches ModalShell's behavior (window-level keydown while open). Use for
 * modals that manage their own markup instead of ModalShell.
 *
 * The listener does not stop propagation: App's own Escape handling (un-focus
 * terminal, blur editor) runs after the modal closes, which is the desired
 * layering — Esc dismisses the top-most thing first.
 */
export function useEscapeKey(onClose: () => void, active = true): void {
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, onClose])
}
