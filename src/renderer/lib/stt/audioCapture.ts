// Microphone capture for voice dictation. Wraps getUserMedia + an AudioContext
// with a small AudioWorklet that streams raw PCM frames to the main thread. On
// stop() the frames are concatenated and resampled to the 16 kHz mono float32
// Whisper expects, ready to transfer to the transcription worker.
//
// Lifecycle: new AudioCapture() → start() (prompts for mic, begins capture) →
// stop() (returns the utterance) or cancel() (discards it). One capture at a
// time; call start() again for the next utterance.

import { resampleTo16kMono, concatFloat32, WHISPER_SAMPLE_RATE } from './resample'
import { PCM_WORKLET_NAME, PCM_WORKLET_SOURCE } from './pcmWorklet'

export class AudioCapture {
  private stream: MediaStream | null = null
  private ctx: AudioContext | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private node: AudioWorkletNode | null = null
  private frames: Float32Array[] = []
  private inputRate = WHISPER_SAMPLE_RATE
  private workletUrl: string | null = null

  /** True while a capture is in progress. */
  get active(): boolean {
    return this.ctx !== null
  }

  /**
   * Request the microphone and begin capturing. Throws if permission is denied
   * or no input device is available — callers map that to a user-facing error.
   * Must be called from a user gesture (click/keypress) so the AudioContext can
   * resume under Chromium's autoplay policy.
   */
  async start(): Promise<void> {
    if (this.ctx) return
    this.frames = []

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    })

    const ctx = new AudioContext()
    this.ctx = ctx
    this.inputRate = ctx.sampleRate
    // The mic click is the gesture; resume in case the context started suspended.
    if (ctx.state === 'suspended') await ctx.resume()

    const blob = new Blob([PCM_WORKLET_SOURCE], { type: 'application/javascript' })
    this.workletUrl = URL.createObjectURL(blob)
    await ctx.audioWorklet.addModule(this.workletUrl)

    this.source = ctx.createMediaStreamSource(this.stream)
    this.node = new AudioWorkletNode(ctx, PCM_WORKLET_NAME)
    this.node.port.onmessage = (e: MessageEvent<Float32Array>) => {
      this.frames.push(e.data)
    }
    this.source.connect(this.node)
    // Connect to the destination so the graph is pulled; a zero-gain node keeps
    // the mic from being echoed to the speakers.
    const sink = ctx.createGain()
    sink.gain.value = 0
    this.node.connect(sink)
    sink.connect(ctx.destination)
  }

  /**
   * Stop capturing and return the utterance as 16 kHz mono float32. Returns an
   * empty buffer if nothing was captured.
   */
  async stop(): Promise<Float32Array> {
    const frames = this.frames
    this.frames = []
    this.teardown()
    if (frames.length === 0) return new Float32Array(0)
    const merged = concatFloat32(frames)
    return resampleTo16kMono(merged, this.inputRate)
  }

  /** Abandon the current capture and discard any audio. */
  cancel(): void {
    this.frames = []
    this.teardown()
  }

  private teardown(): void {
    try {
      this.node?.disconnect()
      this.source?.disconnect()
    } catch {
      /* nodes may already be gone */
    }
    if (this.node) this.node.port.onmessage = null
    this.node = null
    this.source = null
    for (const track of this.stream?.getTracks() ?? []) track.stop()
    this.stream = null
    void this.ctx?.close().catch(() => undefined)
    this.ctx = null
    if (this.workletUrl) {
      URL.revokeObjectURL(this.workletUrl)
      this.workletUrl = null
    }
  }
}
