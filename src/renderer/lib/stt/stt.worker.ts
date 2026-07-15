// Speech-to-text Web Worker. Runs Whisper locally via Transformers.js on ONNX
// Runtime Web — WebGPU when the machine supports it (fast), WASM otherwise (CPU,
// works everywhere). Kept off the main thread so model load and inference never
// block the UI.
//
// It knows nothing about the terminal or React: it takes audio, returns text.
// The model is fetched from the Hugging Face CDN on first use and cached by the
// browser Cache API (persisted in DevTerm's userData partition), so subsequent
// launches are offline. ORT's own wasm binaries are served locally from /ort/
// (copied out of node_modules by scripts/setup-native.mjs) so nothing but the
// model weights ever needs the network.

import { pipeline, env } from '@huggingface/transformers'
import type { STTRequest, STTResponse } from './protocol'
import type { STTBackend, STTModelId } from '@shared/types'

// The pipeline factory's overloads produce a union too complex for tsc to
// represent (TS2590) when called with options; narrow it to a simple signature.
type Transcriber = (
  audio: Float32Array,
  opts: Record<string, unknown>
) => Promise<{ text?: string } | Array<{ text?: string }>>
const loadPipeline = pipeline as unknown as (
  task: string,
  model: string,
  opts: Record<string, unknown>
) => Promise<Transcriber & { dispose?: () => Promise<void> }>

// Only fetch models from the HF hub; we never ship local model files.
env.allowLocalModels = false
const onnxWasm = env.backends?.onnx?.wasm
if (onnxWasm) {
  // Serve onnxruntime-web's wasm from our own origin (copied to public/ort by
  // scripts/setup-native.mjs). In dev the renderer is an http server and Vite
  // serves public/ at the root, so `/ort/` works. In a packaged build the page
  // loads over file://, where an absolute `/ort/` would resolve to the drive
  // root — so resolve it relative to this worker's own location instead (the
  // worker bundles into assets/, with ort/ a sibling one level up). Trailing
  // slash matters: ORT appends the filename.
  onnxWasm.wasmPaths =
    self.location.protocol === 'file:'
      ? new URL('../ort/', self.location.href).href
      : '/ort/'
  // The .jsep build bundles single- and multi-threaded in one file; cross-origin
  // isolation isn't guaranteed in Electron, so keep ORT to a single thread rather
  // than risk a SharedArrayBuffer failure.
  onnxWasm.numThreads = 1
}

const post = (msg: STTResponse, transfer?: Transferable[]): void => {
  ;(self as unknown as Worker).postMessage(msg, transfer ?? [])
}

const repoFor = (modelId: STTModelId): string => `Xenova/whisper-${modelId}`

let transcriber: (Transcriber & { dispose?: () => Promise<void> }) | null = null
let loadedModel: STTModelId | null = null
let backend: STTBackend = 'wasm'
let loading: Promise<void> | null = null

async function ensureLoaded(modelId: STTModelId): Promise<void> {
  if (transcriber && loadedModel === modelId) return
  if (loading) {
    await loading
    if (transcriber && loadedModel === modelId) return
  }

  loading = (async () => {
    // Dispose any previously-loaded model when the user switches size.
    if (transcriber && loadedModel !== modelId) {
      try {
        await transcriber.dispose?.()
      } catch {
        /* best effort */
      }
      transcriber = null
      loadedModel = null
    }

    const repo = repoFor(modelId)
    const progress_callback = (p: unknown): void => {
      const e = p as { status?: string; file?: string; progress?: number }
      if (e.status === 'progress' && typeof e.progress === 'number') {
        post({ type: 'download', file: e.file ?? '', progress: e.progress })
      }
    }

    // Prefer WebGPU; fall back to WASM (CPU) on any failure — no navigator.gpu,
    // adapter rejection, or missing ORT WebGPU EP.
    const hasWebGPU = typeof (navigator as unknown as { gpu?: unknown }).gpu !== 'undefined'
    if (hasWebGPU) {
      try {
        transcriber = await loadPipeline('automatic-speech-recognition', repo, {
          device: 'webgpu',
          dtype: 'fp32',
          progress_callback
        })
        backend = 'webgpu'
      } catch {
        transcriber = null
      }
    }
    if (!transcriber) {
      transcriber = await loadPipeline('automatic-speech-recognition', repo, {
        device: 'wasm',
        dtype: 'q8',
        progress_callback
      })
      backend = 'wasm'
    }

    loadedModel = modelId
    post({ type: 'ready', backend, modelId })
  })()

  try {
    await loading
  } finally {
    loading = null
  }
}

self.onmessage = async (e: MessageEvent<STTRequest>): Promise<void> => {
  const msg = e.data
  try {
    if (msg.type === 'load') {
      await ensureLoaded(msg.modelId)
      return
    }
    if (msg.type === 'transcribe') {
      post({ type: 'transcribing', id: msg.id })
      // ensureLoaded is a no-op if the requested model is already resident.
      await ensureLoaded(msg.modelId)
      if (!transcriber) throw new Error('Model not loaded')

      const out = await transcriber(msg.audio, {
        // Whisper's native window is 30s; chunking with overlap handles longer
        // utterances without the caller having to segment.
        chunk_length_s: 30,
        stride_length_s: 5,
        language: msg.language === 'auto' ? undefined : msg.language,
        task: 'transcribe'
      })
      const text = Array.isArray(out)
        ? out.map((o) => o.text ?? '').join(' ')
        : (out.text ?? '')
      post({ type: 'transcript', id: msg.id, text })
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const id = msg.type === 'transcribe' ? msg.id : undefined
    // A load failure is fatal (nothing will work); a single transcription
    // failure is recoverable (the next utterance may succeed).
    post({ type: 'error', id, message, fatal: msg.type === 'load' })
  }
}
