/**
 * Bounded raw terminal output retained by the main process.
 *
 * The renderer's xterm buffer is deliberately not involved here. Keeping the
 * raw ANSI stream lets hidden-group hibernation recreate an xterm and replay
 * the same bytes it would have received while it was visible.
 *
 * Output arrives in arbitrary chunks, so completed lines are stored in a
 * circular queue and the current unterminated line is kept separately. This
 * preserves chunk concatenation across writes while allowing the oldest
 * complete lines to be discarded without shifting a large array on every
 * output burst.
 */

export const DEFAULT_OUTPUT_RING_LINES = 10_000
export const MAX_OUTPUT_RING_LINES = 100_000

/**
 * A line cap is the primary bound. This byte cap is a second guard for a
 * command/TUI that emits one enormous unterminated line. It is intentionally
 * independent of the renderer's xterm scrollback setting because it protects
 * main-process memory even when one line is pathological.
 */
export const DEFAULT_OUTPUT_RING_BYTES = 64 * 1024 * 1024
export const MAX_OUTPUT_RING_BYTES = 64 * 1024 * 1024

export interface OutputRingOptions {
  /** Number of terminal lines to retain, clamped to 1..100000. */
  maxLines?: number
  /** Optional raw UTF-8 byte bound, clamped to the hard safety ceiling. */
  maxBytes?: number
}

function clampInteger(value: number | undefined, fallback: number, max: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.max(1, Math.min(max, Math.floor(value as number)))
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

/** Return the longest suffix whose UTF-8 representation fits maxBytes. */
function suffixWithinBytes(value: string, maxBytes: number): string {
  if (!value || maxBytes <= 0) return ''
  if (utf8Bytes(value) <= maxBytes) return value

  let low = 0
  let high = value.length
  while (low < high) {
    const mid = Math.floor((low + high) / 2)
    if (utf8Bytes(value.slice(mid)) <= maxBytes) high = mid
    else low = mid + 1
  }

  // Do not begin the suffix on the second half of a UTF-16 surrogate pair.
  let start = low
  if (start > 0 && start < value.length) {
    const code = value.charCodeAt(start)
    if (code >= 0xdc00 && code <= 0xdfff) start++
  }
  return value.slice(start)
}

export class OutputRingBuffer {
  private maxLines: number
  private maxBytes: number
  private slots: Array<string | undefined>
  private start = 0
  private size = 0
  private partial = ''
  private bytes = 0

  constructor(options: OutputRingOptions = {}) {
    this.maxLines = clampInteger(options.maxLines, DEFAULT_OUTPUT_RING_LINES, MAX_OUTPUT_RING_LINES)
    this.maxBytes = clampInteger(options.maxBytes, DEFAULT_OUTPUT_RING_BYTES, MAX_OUTPUT_RING_BYTES)
    this.slots = new Array<string | undefined>(this.maxLines)
  }

  get lineCapacity(): number {
    return this.maxLines
  }

  get byteCapacity(): number {
    return this.maxBytes
  }

  /** Number of complete lines plus the current unterminated line, if any. */
  get lineCount(): number {
    return this.size + (this.partial.length > 0 ? 1 : 0)
  }

  get byteLength(): number {
    return this.bytes
  }

  /**
   * Append raw terminal bytes. Newlines are retained exactly; no ANSI
   * stripping or normalization belongs in the replay buffer.
   */
  append(data: string): void {
    if (!data) return

    const combined = this.partial + data
    // The unterminated tail is being re-parsed as part of the next chunk, so
    // replace its previous byte contribution rather than counting it twice.
    this.bytes -= utf8Bytes(this.partial)
    this.partial = ''

    let lineStart = 0
    while (true) {
      const newline = combined.indexOf('\n', lineStart)
      if (newline < 0) break
      this.pushCompleteLine(combined.slice(lineStart, newline + 1))
      lineStart = newline + 1
    }
    this.partial = combined.slice(lineStart)
    this.bytes += utf8Bytes(this.partial)
    this.trim()
  }

  /** Return the retained raw stream in chronological order. */
  replay(): string {
    if (this.size === 0) return this.partial
    const lines: string[] = new Array(this.size)
    for (let i = 0; i < this.size; i++) {
      lines[i] = this.slots[(this.start + i) % this.maxLines] ?? ''
    }
    return lines.join('') + this.partial
  }

  /** Change limits without discarding newer output unnecessarily. */
  setLimits(options: OutputRingOptions): void {
    const nextLines = clampInteger(options.maxLines, this.maxLines, MAX_OUTPUT_RING_LINES)
    const nextBytes = clampInteger(options.maxBytes, this.maxBytes, MAX_OUTPUT_RING_BYTES)
    if (nextLines !== this.maxLines) {
      const retained = this.completeLines().slice(-nextLines)
      this.maxLines = nextLines
      this.slots = new Array<string | undefined>(nextLines)
      this.start = 0
      this.size = 0
      this.bytes = utf8Bytes(this.partial)
      for (const line of retained) this.pushCompleteLine(line)
    }
    this.maxBytes = nextBytes
    this.trim()
  }

  clear(): void {
    this.slots.fill(undefined)
    this.start = 0
    this.size = 0
    this.partial = ''
    this.bytes = 0
  }

  private completeLines(): string[] {
    const out: string[] = new Array(this.size)
    for (let i = 0; i < this.size; i++) {
      out[i] = this.slots[(this.start + i) % this.maxLines] ?? ''
    }
    return out
  }

  private pushCompleteLine(line: string): void {
    const lineBytes = utf8Bytes(line)
    if (this.size < this.maxLines) {
      this.slots[(this.start + this.size) % this.maxLines] = line
      this.size++
    } else {
      const old = this.slots[this.start] ?? ''
      this.bytes -= utf8Bytes(old)
      this.slots[this.start] = line
      this.start = (this.start + 1) % this.maxLines
    }
    this.bytes += lineBytes
  }

  private removeOldest(): void {
    if (this.size === 0) return
    const old = this.slots[this.start] ?? ''
    this.slots[this.start] = undefined
    this.start = (this.start + 1) % this.maxLines
    this.size--
    this.bytes -= utf8Bytes(old)
  }

  private replaceOldest(line: string): void {
    if (this.size === 0) return
    const old = this.slots[this.start] ?? ''
    this.slots[this.start] = line
    this.bytes += utf8Bytes(line) - utf8Bytes(old)
  }

  private trim(): void {
    // A current unterminated line consumes one line of the configured cap.
    while (this.lineCount > this.maxLines) this.removeOldest()

    // Drop whole oldest lines first. If the oldest retained line itself is
    // larger than the byte cap, keep its newest suffix rather than allowing a
    // single command to make the ring unbounded.
    while (this.bytes > this.maxBytes && this.size > 0) {
      const oldest = this.slots[this.start] ?? ''
      const oldestBytes = utf8Bytes(oldest)
      const bytesWithoutOldest = this.bytes - oldestBytes
      const allowed = this.maxBytes - bytesWithoutOldest
      if (allowed <= 0) {
        this.removeOldest()
        continue
      }
      if (oldestBytes > allowed) this.replaceOldest(suffixWithinBytes(oldest, allowed))
      break
    }

    if (this.bytes > this.maxBytes && this.size === 0) {
      this.partial = suffixWithinBytes(this.partial, this.maxBytes)
      this.bytes = utf8Bytes(this.partial)
    }
  }
}

/** Namespace prefixes keep a PTY UUID from colliding with an SSH session id. */
export function outputStreamKey(kind: 'pty' | 'ssh', id: string): string {
  return `${kind}:${id}`
}

/**
 * Main-process registry for live terminal streams. `forwarding` is deliberately
 * open by default: visible streams forward every coalesced burst exactly as
 * before. Hibernation closes one stream's gate while continuing to append to
 * and replay its ring.
 */
export class OutputRingStore {
  private readonly rings = new Map<string, OutputRingBuffer>()
  private readonly forwarding = new Map<string, boolean>()
  private readonly sessionStreams = new Map<string, string>()
  private maxLines: number
  private maxBytes: number

  constructor(options: OutputRingOptions = {}) {
    const ring = new OutputRingBuffer(options)
    this.maxLines = ring.lineCapacity
    this.maxBytes = ring.byteCapacity
  }

  append(id: string, data: string): void {
    this.getOrCreate(id).append(data)
  }

  replay(id: string): string {
    return this.rings.get(id)?.replay() ?? ''
  }

  setLimits(options: OutputRingOptions): void {
    if (options.maxLines !== undefined) {
      this.maxLines = new OutputRingBuffer({ maxLines: options.maxLines }).lineCapacity
    }
    if (options.maxBytes !== undefined) {
      this.maxBytes = new OutputRingBuffer({ maxBytes: options.maxBytes }).byteCapacity
    }
    for (const ring of this.rings.values()) {
      ring.setLimits({ maxLines: this.maxLines, maxBytes: this.maxBytes })
    }
  }

  setForwarding(id: string, enabled: boolean): void {
    if (enabled) this.forwarding.delete(id)
    else this.forwarding.set(id, false)
  }

  isForwarding(id: string): boolean {
    return this.forwarding.get(id) ?? true
  }

  /** Associate a renderer session with its private PTY/SSH output stream. */
  bindSession(sessionId: string, streamId: string): void {
    this.sessionStreams.set(sessionId, streamId)
  }

  unbindSession(sessionId: string, streamId?: string): void {
    if (streamId && this.sessionStreams.get(sessionId) !== streamId) return
    this.sessionStreams.delete(sessionId)
  }

  setForwardingForSession(sessionId: string, enabled: boolean): boolean {
    const streamId = this.sessionStreams.get(sessionId)
    if (!streamId) return false
    this.setForwarding(streamId, enabled)
    return true
  }

  /** Capture the retained bytes, then reopen the live forwarding gate. */
  replayAndResume(sessionId: string): string {
    const streamId = this.sessionStreams.get(sessionId)
    if (!streamId) return ''
    const replay = this.replay(streamId)
    this.setForwarding(streamId, true)
    return replay
  }

  /** Read the retained bytes without changing the renderer forwarding gate. */
  replayForSession(sessionId: string): string {
    const streamId = this.sessionStreams.get(sessionId)
    return streamId ? this.replay(streamId) : ''
  }

  remove(id: string): void {
    this.rings.delete(id)
    this.forwarding.delete(id)
    for (const [sessionId, streamId] of this.sessionStreams) {
      if (streamId === id) this.sessionStreams.delete(sessionId)
    }
  }

  private getOrCreate(id: string): OutputRingBuffer {
    let ring = this.rings.get(id)
    if (!ring) {
      ring = new OutputRingBuffer({ maxLines: this.maxLines, maxBytes: this.maxBytes })
      this.rings.set(id, ring)
    }
    return ring
  }
}

/** Shared by the PTY and SSH IPC data paths in the main process. */
export const globalOutputRings = new OutputRingStore()
