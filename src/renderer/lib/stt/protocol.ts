// Message protocol between the dictation controller (main thread) and the STT
// Web Worker. Kept in its own module so both sides import the exact same shapes
// and neither pulls in the other's heavy dependencies.

import type { STTBackend, STTModelId, STTLanguage } from '@shared/types'

/** Controller → worker. */
export type STTRequest =
  | { type: 'load'; modelId: STTModelId }
  | {
      type: 'transcribe'
      id: number
      audio: Float32Array
      language: STTLanguage
    }

/** Worker → controller. */
export type STTResponse =
  | { type: 'ready'; backend: STTBackend; modelId: STTModelId }
  | { type: 'download'; file: string; progress: number }
  | { type: 'transcribing'; id: number }
  | { type: 'transcript'; id: number; text: string }
  | { type: 'error'; id?: number; message: string; fatal: boolean }
