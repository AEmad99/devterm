import { useCallback, useState } from 'react'

/**
 * Dirty-guard for modal forms: intercepts backdrop/Esc/Cancel closes while
 * `dirty` and asks for confirmation via the caller's own ConfirmDialog.
 *
 * Usage:
 *   const guard = useDirtyGuard(isDirty)
 *   <div className="modal-backdrop" onClick={guard.requestClose(onClose)}>
 *   ...
 *   {guard.confirming && (
 *     <ConfirmDialog open title="Discard changes?" ... onConfirm={guard.confirm} onClose={guard.cancel} />
 *   )}
 */
export function useDirtyGuard(dirty: boolean) {
  const [confirming, setConfirming] = useState(false)
  // The close that is waiting on the operator's decision.
  const [pending, setPending] = useState<(() => void) | null>(null)

  const requestClose = useCallback(
    (onClose: () => void) => () => {
      if (!dirty) {
        onClose()
        return
      }
      setPending(() => onClose)
      setConfirming(true)
    },
    [dirty]
  )

  const confirm = useCallback(() => {
    setConfirming(false)
    const fn = pending
    setPending(null)
    fn?.()
  }, [pending])

  const cancel = useCallback(() => {
    setConfirming(false)
    setPending(null)
  }, [])

  return { confirming, requestClose, confirm, cancel }
}
