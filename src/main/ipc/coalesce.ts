/**
 * Coalesce high-frequency per-id data into batched flushes. node-pty / ssh2 can
 * emit many tiny chunks (fast command output, a TUI like Claude Code redrawing);
 * one IPC message per chunk churns the renderer. Batching bursts within a few ms
 * into a single message cuts IPC overhead with no perceptible added latency.
 */
export function makeCoalescer(
  flush: (id: string, data: string) => void,
  delayMs = 4
): (id: string, data: string) => void {
  const buffers = new Map<string, string>()
  const timers = new Map<string, NodeJS.Timeout>()
  return (id, data) => {
    buffers.set(id, (buffers.get(id) ?? '') + data)
    if (timers.has(id)) return
    timers.set(
      id,
      setTimeout(() => {
        const buf = buffers.get(id) ?? ''
        buffers.delete(id)
        timers.delete(id)
        if (buf) flush(id, buf)
      }, delayMs)
    )
  }
}
