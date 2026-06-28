/**
 * Coalesce high-frequency per-id data into batched flushes. node-pty / ssh2 can
 * emit many tiny chunks (fast command output, a TUI like pi redrawing);
 * one IPC message per chunk churns the renderer. Batching bursts within a few ms
 * into a single message cuts IPC overhead with no perceptible added latency.
 *
 * Implementation note (perf): chunks are appended to an array and joined at flush
 * time. The naive `(buf += data)` approach is O(N²) in the burst size — each
 * `push` copies the whole accumulated buffer — so a 4 ms burst of 200 × 4 KB
 * chunks spends ~N²/2 bytes in intermediate garbage and triggers a matching GC
 * pass. The chunk-list path is linear: appending to an array is amortized O(1),
 * and one `join` allocates the final string in a single pass.
 *
 * Returns `{ push, flush }`. `push(id, data)` queues a chunk; `flush(id)` emits
 * any buffered chunk for `id` immediately and cancels its pending timer. Callers
 * MUST `flush(id)` right before sending a terminal exit/close event for that id —
 * otherwise the exit banner can overtake the last buffered output chunk (the
 * data is still sitting in the 4ms buffer when the un-coalesced exit fires).
 */
export interface Coalescer {
  push: (id: string, data: string) => void
  flush: (id: string) => void
}

export function makeCoalescer(sink: (id: string, data: string) => void, delayMs = 4): Coalescer {
  // Per-id queue of incoming chunks, joined on flush. Using an array instead of
  // a concatenated string keeps each `push` O(1) instead of O(current total size).
  const buffers = new Map<string, string[]>()
  const timers = new Map<string, NodeJS.Timeout>()
  const emit = (id: string): void => {
    const chunks = buffers.get(id)
    buffers.delete(id)
    const t = timers.get(id)
    if (t) clearTimeout(t)
    timers.delete(id)
    if (!chunks || chunks.length === 0) return
    // Single allocation + single copy. A burst of 200 chunks becomes one
    // concatenated string instead of 200 progressively-larger copies.
    sink(id, chunks.length === 1 ? chunks[0] : chunks.join(''))
  }
  return {
    push: (id, data) => {
      if (!data) return
      let q = buffers.get(id)
      if (!q) {
        q = []
        buffers.set(id, q)
      }
      q.push(data)
      if (timers.has(id)) return
      timers.set(id, setTimeout(() => emit(id), delayMs))
    },
    flush: (id) => emit(id)
  }
}
