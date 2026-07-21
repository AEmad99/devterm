// Dictation controller: the single owner of the STT worker and microphone
// capture. UI calls toggle()/start()/stop(); it drives the capture + worker and
// inserts the final transcript into the active terminal via sendToActive().
//
// A module-level singleton (not React state) because the worker and the mic
// stream must outlive any component and there is only ever one active dictation.
// The worker is created lazily on first use so idle app startup pays nothing —
// Transformers.js (~MBs) only loads when the user first dictates.

import { sendToActive } from '../input'
import { useSettings } from '../../store/settings'
import { useDictation } from '../../store/dictation'
import { AudioCapture } from './audioCapture'
import type { STTRequest, STTResponse } from './protocol'
import type { STTModelId } from '@shared/types'

class DictationController {
  private worker: Worker | null = null
  private capture = new AudioCapture()
  private reqId = 0
  /** Id of the most recently issued transcribe request; 0 = none in flight. */
  private lastTranscribeId = 0
  private currentModel: STTModelId | null = null

  private setState = useDictation.getState().set

  /** Toggle recording: start if idle, stop-and-transcribe if recording. */
  async toggle(): Promise<void> {
    const status = useDictation.getState().status
    if (status === 'recording') {
      await this.stop()
    } else if (status === 'idle' || status === 'error') {
      await this.start()
    }
    // While loading/requesting-mic/transcribing, ignore toggles.
  }

  /** Begin capturing the microphone. */
  async start(): Promise<void> {
    const { stt } = useSettings.getState()
    if (!stt.enabled) return
    if (this.capture.active) return

    this.setState({ status: 'requesting-mic', error: null, progress: null })
    // Kick off model load in parallel with the mic prompt so the first
    // transcription isn't waiting on a cold download afterwards.
    this.ensureWorker(stt.modelId)

    try {
      await this.capture.start()
    } catch (err) {
      const message = permissionMessage(err)
      this.setState({ status: 'error', error: message })
      return
    }
    this.setState({ status: 'recording' })
  }

  /** Stop capturing and transcribe the utterance. */
  async stop(): Promise<void> {
    if (!this.capture.active) return
    const audio = await this.capture.stop()
    const { stt } = useSettings.getState()

    if (audio.length === 0) {
      this.setState({ status: 'idle' })
      return
    }

    this.setState({ status: 'transcribing', progress: null })
    const worker = this.ensureWorker(stt.modelId)
    const id = ++this.reqId
    this.lastTranscribeId = id
    const req: STTRequest = { type: 'transcribe', id, modelId: stt.modelId, audio, language: stt.language }
    // Transfer the audio buffer to avoid a copy; it's freshly allocated per
    // utterance by the resampler so detaching it is safe.
    worker.postMessage(req, [audio.buffer])
  }

  /** Abandon a recording without transcribing. */
  cancel(): void {
    this.capture.cancel()
    // Invalidate any in-flight transcription so its late result is dropped.
    this.lastTranscribeId = 0
    if (useDictation.getState().status !== 'error') this.setState({ status: 'idle' })
  }

  private ensureWorker(modelId: STTModelId): Worker {
    if (this.worker && this.currentModel === modelId) return this.worker

    if (this.worker && this.currentModel !== modelId) {
      // Model changed in settings: reload it in the existing worker.
      this.currentModel = modelId
      this.worker.postMessage({ type: 'load', modelId } satisfies STTRequest)
      this.setState({ status: 'loading', progress: 0, backend: null })
      return this.worker
    }

    this.worker?.terminate()
    const worker = new Worker(new URL('./stt.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (e: MessageEvent<STTResponse>) => this.onMessage(e.data)
    worker.onerror = (e) => {
      this.worker = null
      this.currentModel = null
      this.setState({ status: 'error', error: e.message || 'Speech worker crashed' })
    }
    this.worker = worker
    this.currentModel = modelId
    worker.postMessage({ type: 'load', modelId } satisfies STTRequest)
    this.setState({ status: 'loading', progress: 0, backend: null })
    return worker
  }

  private onMessage(msg: STTResponse): void {
    switch (msg.type) {
      case 'download':
        {
          const s = useDictation.getState().status
          if (s === 'loading' || s === 'idle' || s === 'error') {
            this.setState({ status: 'loading', progress: msg.progress / 100 })
          }
        }
        break
      case 'ready':
        if (msg.modelId !== this.currentModel) break
        this.setState({
          backend: msg.backend,
          progress: null,
          // Don't stomp an in-flight recording/transcription state.
          status: transientStatus(useDictation.getState().status)
        })
        break
      case 'transcribing':
        if (msg.id !== this.lastTranscribeId) break
        this.setState({ status: 'transcribing' })
        break
      case 'transcript': {
        // Drop results for requests that were cancelled or superseded.
        if (msg.id !== this.lastTranscribeId) break
        this.lastTranscribeId = 0
        const { stt } = useSettings.getState()
        const text = msg.text.trim()
        // Whisper hallucinates short tokens on silence; ignore trivial output.
        if (text.length >= 2) {
          sendToActive(stt.appendSpace ? text + ' ' : text)
        }
        this.setState({ status: 'idle', progress: null })
        break
      }
      case 'error':
        // Load errors carry no id and always apply; transcribe errors only
        // apply when they answer the in-flight request.
        if (msg.id !== undefined && msg.id !== this.lastTranscribeId) break
        this.lastTranscribeId = 0
        this.setState({ status: 'error', error: msg.message, progress: null })
        break
    }
  }
}

/** After a `ready`, return to idle unless we're mid-capture/transcribe. */
function transientStatus(current: string): 'idle' | 'recording' | 'transcribing' {
  if (current === 'recording') return 'recording'
  if (current === 'transcribing') return 'transcribing'
  return 'idle'
}

function permissionMessage(err: unknown): string {
  const name = (err as { name?: string })?.name
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Microphone permission denied'
  if (name === 'NotFoundError') return 'No microphone found'
  if (name === 'NotReadableError') return 'Microphone is in use by another app'
  return err instanceof Error ? err.message : 'Could not access the microphone'
}

/** The process-wide dictation controller. */
export const dictation = new DictationController()
