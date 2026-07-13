// Resample captured mono PCM to the 16 kHz float32 that Whisper expects.
//
// getUserMedia gives us audio at the AudioContext's sample rate (commonly 44100
// or 48000 Hz), but Whisper's feature extractor is trained on 16 kHz mono in the
// [-1, 1] range. We downsample on the main thread before handing the buffer to
// the worker so the model receives exactly what it wants and the transferred
// buffer is as small as possible.
//
// Linear interpolation is intentionally simple: speech STT is robust to the mild
// aliasing it introduces, and a polyphase/FIR resampler would be far more code
// for no measurable accuracy gain at these rates. Pure function, no deps — unit
// tested in resample.test.ts.

export const WHISPER_SAMPLE_RATE = 16000

/**
 * Resample a mono Float32 PCM buffer to 16 kHz. Returns the input unchanged (a
 * copy is not made) when it is already at 16 kHz. Values are assumed to be in
 * [-1, 1] and are passed through as-is.
 */
export function resampleTo16kMono(input: Float32Array, inputRate: number): Float32Array {
  if (!Number.isFinite(inputRate) || inputRate <= 0) {
    throw new Error(`resampleTo16kMono: invalid inputRate ${inputRate}`)
  }
  if (inputRate === WHISPER_SAMPLE_RATE || input.length === 0) return input

  const ratio = inputRate / WHISPER_SAMPLE_RATE
  const outLength = Math.max(1, Math.round(input.length / ratio))
  const output = new Float32Array(outLength)

  for (let i = 0; i < outLength; i++) {
    // Position in the source buffer this output sample maps to.
    const srcPos = i * ratio
    const i0 = Math.floor(srcPos)
    const i1 = Math.min(i0 + 1, input.length - 1)
    const frac = srcPos - i0
    output[i] = input[i0] * (1 - frac) + input[i1] * frac
  }
  return output
}

/**
 * Concatenate a list of Float32 frames (as posted by the audio worklet) into one
 * contiguous buffer. Kept here alongside the resampler because callers always do
 * both: gather frames, then resample the whole utterance at once.
 */
export function concatFloat32(frames: Float32Array[]): Float32Array {
  let total = 0
  for (const f of frames) total += f.length
  const out = new Float32Array(total)
  let offset = 0
  for (const f of frames) {
    out.set(f, offset)
    offset += f.length
  }
  return out
}
