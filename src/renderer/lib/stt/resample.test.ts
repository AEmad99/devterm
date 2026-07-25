import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resampleTo16kMono, concatFloat32, WHISPER_SAMPLE_RATE } from './resample'

test('returns the same buffer when already 16 kHz', () => {
  const input = new Float32Array([0, 0.5, -0.5, 1])
  const out = resampleTo16kMono(input, WHISPER_SAMPLE_RATE)
  assert.equal(out, input)
})

test('empty input returns empty', () => {
  const out = resampleTo16kMono(new Float32Array(0), 48000)
  assert.equal(out.length, 0)
})

test('downsamples 48 kHz to 16 kHz at a 1/3 length ratio', () => {
  const input = new Float32Array(4800) // 0.1s at 48kHz
  const out = resampleTo16kMono(input, 48000)
  assert.equal(out.length, 1600) // 0.1s at 16kHz
})

test('downsamples 44.1 kHz to roughly the right length', () => {
  const input = new Float32Array(44100) // 1s
  const out = resampleTo16kMono(input, 44100)
  // 44100 / (44100/16000) = 16000
  assert.equal(out.length, 16000)
})

test('preserves a constant DC signal exactly', () => {
  const input = new Float32Array(48000).fill(0.42)
  const out = resampleTo16kMono(input, 48000)
  for (const v of out) assert.ok(Math.abs(v - 0.42) < 1e-6)
})

test('linearly interpolates between samples', () => {
  // Upsample-ish edge: rate below 16k forces interpolation across neighbours.
  const input = new Float32Array([0, 1])
  const out = resampleTo16kMono(input, 8000) // ratio 0.5 → ~4 samples
  assert.ok(out.length >= 2)
  // First sample maps to source index 0 → exactly 0.
  assert.ok(Math.abs(out[0] - 0) < 1e-6)
  // Values stay within the source range.
  for (const v of out) assert.ok(v >= -1e-6 && v <= 1 + 1e-6)
})

test('rejects a non-positive input rate', () => {
  assert.throws(() => resampleTo16kMono(new Float32Array([1]), 0))
  assert.throws(() => resampleTo16kMono(new Float32Array([1]), -1))
})

test('concatFloat32 joins frames in order', () => {
  const out = concatFloat32([
    new Float32Array([1, 2]),
    new Float32Array([3]),
    new Float32Array([4, 5])
  ])
  assert.deepEqual(Array.from(out), [1, 2, 3, 4, 5])
})

test('concatFloat32 of nothing is empty', () => {
  assert.equal(concatFloat32([]).length, 0)
})
