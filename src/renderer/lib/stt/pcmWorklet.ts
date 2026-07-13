// Source for the microphone capture AudioWorkletProcessor, kept as a string so
// audioCapture.ts can turn it into a Blob URL and hand it to
// `audioContext.audioWorklet.addModule(url)`.
//
// Why a string + Blob instead of a separate `.ts?url` file: an AudioWorklet
// module runs in AudioWorkletGlobalScope and must be plain JS with no app
// imports. Relying on the bundler to transpile a standalone `.ts` worklet and
// emit a stable URL is fragile across dev/prod in electron-vite. A Blob URL is
// bulletproof and has no build-time coupling.
//
// The processor copies each 128-sample render quantum out of the (recycled)
// input buffer and posts it to the main thread, which accumulates frames and
// resamples the whole utterance to 16 kHz at stop() time.

export const PCM_WORKLET_NAME = 'pcm-capture'

export const PCM_WORKLET_SOURCE = /* js */ `
class PCMProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (channel && channel.length > 0) {
      // Copy out of the recycled render buffer before it is overwritten.
      const frame = new Float32Array(channel.length)
      frame.set(channel)
      this.port.postMessage(frame, [frame.buffer])
    }
    return true
  }
}
registerProcessor(${JSON.stringify(PCM_WORKLET_NAME)}, PCMProcessor)
`
