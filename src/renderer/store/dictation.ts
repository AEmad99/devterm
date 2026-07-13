// UI-facing state for voice dictation. The controller (lib/stt/dictation.ts)
// writes to it; MicButton and DictationStatus read from it. Deliberately tiny —
// all the heavy lifting lives in the controller and the worker.

import { create } from 'zustand'
import type { STTBackend } from '@shared/types'

export type DictationStatus =
  | 'idle'
  | 'loading' // model download / worker warm-up
  | 'requesting-mic'
  | 'recording'
  | 'transcribing'
  | 'error'

interface DictationState {
  status: DictationStatus
  /** 0..1 model download progress while `status === 'loading'`, else null. */
  progress: number | null
  /** Which ORT backend the worker chose, once known. */
  backend: STTBackend | null
  /** Last user-facing error message (cleared when a new action starts). */
  error: string | null
  set: (patch: Partial<Omit<DictationState, 'set'>>) => void
}

export const useDictation = create<DictationState>((set) => ({
  status: 'idle',
  progress: null,
  backend: null,
  error: null,
  set: (patch) => set(patch)
}))
