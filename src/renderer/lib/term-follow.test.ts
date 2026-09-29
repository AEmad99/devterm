import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  createPtyResizeGate,
  decideTail,
  keepTerminalFollowTail,
  nextPtySize,
  type TailHost,
  type TailSnapshot
} from './term-follow'

const following: TailSnapshot = { followTail: true, savedViewport: 40 }

describe('decideTail', () => {
  it('pins the viewport back to the latest line when a resize clamps scroll to the top', () => {
    const decision = decideTail(following, {
      viewportY: 0,
      baseY: 40,
      userGesture: false,
      hidden: false
    })
    assert.equal(decision.kind, 'pin-bottom')
    assert.equal(decision.next.followTail, true)
  })

  it('leaves the operator at the top when they scrolled there', () => {
    const decision = decideTail(following, {
      viewportY: 0,
      baseY: 40,
      userGesture: true,
      hidden: false
    })
    assert.equal(decision.kind, 'unchanged')
    assert.equal(decision.next.followTail, false)
    assert.equal(decision.next.savedViewport, 0)
  })

  it('restores a reading position after an unsolicited jump to the first line', () => {
    const decision = decideTail(
      { followTail: false, savedViewport: 18 },
      { viewportY: 0, baseY: 40, userGesture: false, hidden: false }
    )
    assert.equal(decision.kind, 'restore')
    if (decision.kind !== 'restore') return
    assert.equal(decision.line, 18)
  })

  it('does not move the buffer while the pane is hidden', () => {
    const decision = decideTail(following, {
      viewportY: 0,
      baseY: 40,
      userGesture: false,
      hidden: true
    })
    assert.equal(decision.kind, 'unchanged')
    assert.equal(decision.next.savedViewport, 40)
  })
})

describe('nextPtySize', () => {
  it('drops unchanged sizes and a grid too small to be a pane', () => {
    assert.equal(nextPtySize({ cols: 80, rows: 24 }, { cols: 80, rows: 24 }), null)
    assert.equal(nextPtySize({ cols: 80, rows: 24 }, { cols: 1, rows: 1 }), null)
    assert.deepEqual(nextPtySize({ cols: 80, rows: 24 }, { cols: 100, rows: 40 }), {
      cols: 100,
      rows: 40
    })
  })
})

describe('createPtyResizeGate', () => {
  it('sends only the settled size after a burst of layout ticks', async () => {
    const sent: Array<[number, number]> = []
    const gate = createPtyResizeGate((cols, rows) => sent.push([cols, rows]), 30)
    gate.seed(80, 24)
    gate.push(80, 24)
    gate.push(4, 1)
    gate.push(90, 30)
    gate.push(110, 36)
    await new Promise((resolve) => setTimeout(resolve, 70))
    assert.deepEqual(sent, [[110, 36]])
    gate.dispose()
  })
})

describe('keepTerminalFollowTail', () => {
  it('scrolls back to the tail when the viewport jumps to the top on its own', () => {
    let viewportY = 40
    const baseY = 40
    const listeners = new Set<() => void>()
    const term = {
      cols: 80,
      rows: 24,
      buffer: {
        active: {
          get viewportY() {
            return viewportY
          },
          baseY
        }
      },
      scrollToBottom() {
        viewportY = baseY
        for (const listener of listeners) listener()
      },
      scrollToLine(line: number) {
        viewportY = line
        for (const listener of listeners) listener()
      },
      onScroll(cb: () => void) {
        listeners.add(cb)
        return { dispose: () => listeners.delete(cb) }
      }
    }
    const host = fakeHost()
    const guard = keepTerminalFollowTail(term, host)
    viewportY = 0
    for (const listener of listeners) listener()
    assert.equal(viewportY, 40)
    guard.dispose()
  })

  it('stops a hidden pane from applying a clamped scroll event', () => {
    let viewportY = 40
    const listeners = new Set<() => void>()
    const term = {
      cols: 80,
      rows: 24,
      buffer: {
        active: {
          get viewportY() {
            return viewportY
          },
          baseY: 40
        }
      },
      scrollToBottom() {
        viewportY = 40
      },
      scrollToLine(line: number) {
        viewportY = line
      },
      onScroll(cb: () => void) {
        listeners.add(cb)
        return { dispose: () => listeners.delete(cb) }
      }
    }
    const host = fakeHost()
    host.hidden = true
    keepTerminalFollowTail(term, host)
    let stopped = false
    host.emitViewportScroll({
      stopImmediatePropagation() {
        stopped = true
      }
    } as Event)
    assert.equal(stopped, true)
    assert.equal(viewportY, 40)
  })
})

function fakeHost(): TailHost & {
  hidden: boolean
  emitViewportScroll: (ev: Event) => void
} {
  const viewportListeners = new Set<(ev: Event) => void>()
  const host = {
    hidden: false,
    clientWidth: 640,
    clientHeight: 480,
    closest(selector: string) {
      return selector === '.term-hidden' && host.hidden ? host : null
    },
    addEventListener() {
      /* wheel/pointer are not needed for these cases */
    },
    removeEventListener() {
      /* paired with addEventListener */
    },
    querySelector(selector: string) {
      if (selector !== '.xterm-viewport') return null
      return {
        addEventListener(_type: string, cb: (ev: Event) => void) {
          viewportListeners.add(cb)
        },
        removeEventListener(_type: string, cb: (ev: Event) => void) {
          viewportListeners.delete(cb)
        },
        getBoundingClientRect() {
          return { right: 100 }
        }
      }
    },
    emitViewportScroll(ev: Event) {
      for (const listener of viewportListeners) listener(ev)
    }
  }
  return host
}
