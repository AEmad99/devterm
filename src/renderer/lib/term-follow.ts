/**
 * Keep an agent terminal pinned to the latest output.
 *
 * xterm treats a viewport `scroll` whose `scrollTop` was clamped to 0 as the
 * operator scrolling to the top. That clamp happens when the pane is hidden
 * (visibility + off-screen translate) or while a resize rebuilds the scroll
 * area. Agent transcripts then sit at the first line until someone scrolls
 * back down. A resize also SIGWINCHes the PTY; repeating an unchanged or
 * not-yet-settled size makes full-screen agent TUIs redraw from the top.
 */

export interface TailSnapshot {
  followTail: boolean
  savedViewport: number
}

export interface TailObservation {
  viewportY: number
  baseY: number
  userGesture: boolean
  hidden: boolean
}

export type TailDecision =
  | { kind: 'unchanged'; next: TailSnapshot }
  | { kind: 'pin-bottom'; next: TailSnapshot }
  | { kind: 'restore'; line: number; next: TailSnapshot }

/** What to do after xterm reports a viewport move the operator may not have made. */
export function decideTail(state: TailSnapshot, obs: TailObservation): TailDecision {
  if (obs.hidden) return { kind: 'unchanged', next: state }
  const atTail = obs.baseY <= 0 || obs.viewportY >= obs.baseY
  if (obs.userGesture) {
    return {
      kind: 'unchanged',
      next: { followTail: atTail, savedViewport: obs.viewportY }
    }
  }
  if (state.followTail && obs.baseY > 0 && obs.viewportY < obs.baseY) {
    return {
      kind: 'pin-bottom',
      next: { followTail: true, savedViewport: obs.baseY }
    }
  }
  // A jump all the way to the first line, with no wheel or scrollbar input,
  // is the clamped-scrollTop bug. Put the operator back where they were reading.
  if (!state.followTail && obs.viewportY === 0 && state.savedViewport > 0 && obs.baseY > 0) {
    const line = Math.min(state.savedViewport, obs.baseY)
    return { kind: 'restore', line, next: { followTail: false, savedViewport: line } }
  }
  return {
    kind: 'unchanged',
    next: {
      followTail: state.followTail,
      savedViewport: atTail ? obs.baseY : obs.viewportY
    }
  }
}

export interface PtySize {
  cols: number
  rows: number
}

/**
 * Latest size worth sending to the agent PTY. Identical sizes and a grid
 * too small to be a real pane are dropped so a layout tick cannot SIGWINCH
 * the TUI into redrawing from the top of the transcript.
 */
export function nextPtySize(lastSent: PtySize | null, next: PtySize): PtySize | null {
  if (next.cols < 2 || next.rows < 2) return null
  if (lastSent && lastSent.cols === next.cols && lastSent.rows === next.rows) return null
  return next
}

export function createPtyResizeGate(
  send: (cols: number, rows: number) => void,
  delayMs = 120
): {
  seed: (cols: number, rows: number) => void
  push: (cols: number, rows: number) => void
  dispose: () => void
} {
  let armed = false
  let lastSent: PtySize | null = null
  let pending: PtySize | null = null
  let timer: ReturnType<typeof setTimeout> | 0 = 0

  const clear = () => {
    if (timer) clearTimeout(timer)
    timer = 0
  }

  return {
    seed(cols, rows) {
      armed = true
      lastSent = { cols, rows }
      pending = null
      clear()
    },
    push(cols, rows) {
      if (!armed) return
      const accepted = nextPtySize(lastSent, { cols, rows })
      if (!accepted) {
        pending = null
        clear()
        return
      }
      pending = accepted
      clear()
      timer = setTimeout(() => {
        timer = 0
        if (!pending) return
        const next = pending
        pending = null
        if (lastSent && lastSent.cols === next.cols && lastSent.rows === next.rows) return
        lastSent = next
        send(next.cols, next.rows)
      }, delayMs)
    },
    dispose() {
      pending = null
      clear()
    }
  }
}

interface TailTerminal {
  cols: number
  rows: number
  buffer: { active: { viewportY: number; baseY: number } }
  scrollToBottom: () => void
  scrollToLine: (line: number) => void
  onScroll: (cb: () => void) => { dispose: () => void }
}

interface ViewportEl {
  addEventListener: (type: string, cb: (ev: Event) => void, capture?: boolean) => void
  removeEventListener: (type: string, cb: (ev: Event) => void, capture?: boolean) => void
  getBoundingClientRect: () => { right: number }
}

export interface TailHost {
  closest: (selector: string) => unknown
  addEventListener: (
    type: string,
    cb: (ev: Event) => void,
    options?: boolean | AddEventListenerOptions
  ) => void
  removeEventListener: (
    type: string,
    cb: (ev: Event) => void,
    options?: boolean | EventListenerOptions
  ) => void
  querySelector: (selector: string) => ViewportEl | null
  clientWidth: number
  clientHeight: number
}

const GESTURE_MS = 500

export interface TailGuard {
  beforeResize: () => void
  afterResize: () => void
  dispose: () => void
}

/**
 * Pin the live transcript unless the operator scrolls, and ignore viewport
 * events while the pane is parked off-screen.
 */
export function keepTerminalFollowTail(term: TailTerminal, host: TailHost): TailGuard {
  let state: TailSnapshot = { followTail: true, savedViewport: term.buffer.active.viewportY }
  let gestureUntil = 0
  let pointerScrolling = false
  let applying = false
  let disposed = false

  const hidden = () => host.closest('.term-hidden') != null
  const gesture = () => pointerScrolling || Date.now() < gestureUntil
  const noteGesture = () => {
    gestureUntil = Date.now() + GESTURE_MS
  }

  const apply = () => {
    if (disposed || applying || hidden()) return
    const buffer = term.buffer.active
    const decision = decideTail(state, {
      viewportY: buffer.viewportY,
      baseY: buffer.baseY,
      userGesture: gesture(),
      hidden: false
    })
    state = decision.next
    if (decision.kind === 'pin-bottom') {
      applying = true
      term.scrollToBottom()
      applying = false
    } else if (decision.kind === 'restore') {
      applying = true
      term.scrollToLine(decision.line)
      applying = false
    }
  }

  const onScroll = () => apply()
  const scrollSub = term.onScroll(onScroll)

  const onWheel = () => noteGesture()
  const onKeyDown = (ev: Event) => {
    const key = (ev as KeyboardEvent).key
    if (key === 'PageUp' || key === 'PageDown' || key === 'Home' || key === 'End') noteGesture()
  }
  const onPointerDown = (ev: Event) => {
    const pe = ev as PointerEvent
    const viewport = host.querySelector('.xterm-viewport')
    if (!viewport) return
    const right = viewport.getBoundingClientRect().right
    if (pe.clientX >= right - 20) {
      pointerScrolling = true
      noteGesture()
    }
  }
  const onPointerUp = () => {
    if (!pointerScrolling) return
    pointerScrolling = false
    noteGesture()
  }

  host.addEventListener('wheel', onWheel, { capture: true, passive: true })
  host.addEventListener('keydown', onKeyDown, true)
  host.addEventListener('pointerdown', onPointerDown, true)
  host.addEventListener('pointerup', onPointerUp, true)
  host.addEventListener('pointercancel', onPointerUp, true)

  let viewport: ViewportEl | null = null
  const onViewportScroll = (ev: Event) => {
    if (hidden()) ev.stopImmediatePropagation()
  }
  const attachViewport = () => {
    const next = host.querySelector('.xterm-viewport')
    if (!next || next === viewport) return
    viewport?.removeEventListener('scroll', onViewportScroll, true)
    viewport = next
    viewport.addEventListener('scroll', onViewportScroll, true)
  }
  attachViewport()

  return {
    beforeResize() {
      if (hidden()) return
      const buffer = term.buffer.active
      const atTail = buffer.baseY <= 0 || buffer.viewportY >= buffer.baseY
      // A resize often clamps the viewport to 0 before this runs. That is not
      // the operator leaving the tail, so keep following and let afterResize
      // pin the bottom. Only snapshot a position they had already scrolled to.
      if (state.followTail) return
      state = { followTail: false, savedViewport: atTail ? buffer.baseY : buffer.viewportY }
    },
    afterResize() {
      if (disposed || hidden()) return
      applying = true
      if (state.followTail) term.scrollToBottom()
      else term.scrollToLine(Math.max(0, Math.min(state.savedViewport, term.buffer.active.baseY)))
      applying = false
    },
    dispose() {
      disposed = true
      scrollSub.dispose()
      host.removeEventListener('wheel', onWheel, true)
      host.removeEventListener('keydown', onKeyDown, true)
      host.removeEventListener('pointerdown', onPointerDown, true)
      host.removeEventListener('pointerup', onPointerUp, true)
      host.removeEventListener('pointercancel', onPointerUp, true)
      viewport?.removeEventListener('scroll', onViewportScroll, true)
    }
  }
}

/** Wait until the agent host's box stops changing so the PTY starts at its real size. */
export function waitForHostBox(
  host: { clientWidth: number; clientHeight: number },
  frames = 3
): Promise<void> {
  return new Promise((resolve) => {
    let last = ''
    let stable = 0
    let ticks = 0
    const tick = () => {
      ticks += 1
      const box = `${host.clientWidth}x${host.clientHeight}`
      const usable = host.clientWidth >= 40 && host.clientHeight >= 40
      if (usable && box === last) stable += 1
      else stable = 0
      last = box
      if (stable >= frames || ticks >= 12) resolve()
      else requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
}
