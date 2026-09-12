import { create } from 'zustand'

export type ToastTone = 'info' | 'ok' | 'err'

export interface Toast {
  id: number
  message: string
  tone: ToastTone
}

interface ToastsState {
  toasts: Toast[]
  push: (message: string, tone?: ToastTone) => void
  dismiss: (id: number) => void
}

let nextId = 1
const TOAST_TTL_MS = 3600

/**
 * Transient confirmations for quiet actions (saved, deleted, copied,
 * imported). Rendered by <Toasts/> in App; fire from anywhere via the
 * `toast()` helper. Auto-dismisses; clicking a toast dismisses it early.
 */
export const useToasts = create<ToastsState>((set) => ({
  toasts: [],
  push: (message, tone = 'info') => {
    const id = nextId++
    set((s) => ({ toasts: [...s.toasts.slice(-3), { id, message, tone }] }))
    setTimeout(() => {
      useToasts.getState().dismiss(id)
    }, TOAST_TTL_MS)
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
}))

export function toast(message: string, tone: ToastTone = 'info'): void {
  useToasts.getState().push(message, tone)
}
