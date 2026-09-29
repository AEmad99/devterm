import type { BrowserPointerEvent } from './types'

/** Kinds the renderer knows how to draw. Anything else is dropped. */
export const POINTER_KINDS = [
  'move',
  'click',
  'type',
  'hover',
  'scroll',
  'key',
  'navigate'
] as const

export type PointerKind = (typeof POINTER_KINDS)[number]

const KIND_SET = new Set<string>(POINTER_KINDS)
const LABEL_MAX = 48
const VIEWPORT_MAX = 20000

function finite(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n)
}

/**
 * Drop malformed pointer IPC. Coords must be finite, labels stay short, and
 * only known kinds are accepted. Missing x/y is valid: the cue is centered.
 */
export function sanitizePointerEvent(raw: unknown): BrowserPointerEvent | null {
  if (!raw || typeof raw !== 'object') return null
  const ev = raw as Partial<BrowserPointerEvent>
  if (typeof ev.tabKey !== 'string') return null
  const tabKey = ev.tabKey.trim()
  if (!tabKey || tabKey.length > 200) return null
  if (typeof ev.kind !== 'string' || !KIND_SET.has(ev.kind)) return null

  const out: BrowserPointerEvent = { tabKey, kind: ev.kind }
  if (finite(ev.x)) out.x = ev.x
  if (finite(ev.y)) out.y = ev.y
  // A single axis is not a point. Drop both so the cue centers instead of
  // sticking to a corner.
  if (out.x === undefined || out.y === undefined) {
    delete out.x
    delete out.y
  }
  if (finite(ev.vw) && ev.vw > 0 && ev.vw <= VIEWPORT_MAX) out.vw = ev.vw
  if (finite(ev.vh) && ev.vh > 0 && ev.vh <= VIEWPORT_MAX) out.vh = ev.vh
  if (finite(ev.zoom) && ev.zoom > 0 && ev.zoom <= 8) out.zoom = ev.zoom
  if (finite(ev.seq) && ev.seq >= 0 && ev.seq < 1e15) out.seq = Math.floor(ev.seq)
  if (typeof ev.label === 'string') {
    const label = ev.label.replace(/\s+/g, ' ').trim().slice(0, LABEL_MAX)
    if (label) out.label = label
  }
  if (
    ev.direction === 'up' ||
    ev.direction === 'down' ||
    ev.direction === 'left' ||
    ev.direction === 'right'
  ) {
    out.direction = ev.direction
  }
  return out
}

export interface PointerPlacement {
  /** Overlay CSS pixels. Null until the stage has a real box, or when centered. */
  x: number | null
  y: number | null
  centered: boolean
  /** The mapped point sat outside the stage and was pulled inside. */
  clamped: boolean
  labelSide: 'left' | 'right'
  /**
   * False when guest coords arrived before the webview has a size. The
   * caller keeps the raw event and places it again on the next resize.
   */
  ready: boolean
}

const MARGIN = 18

/**
 * Map guest-viewport CSS pixels onto the webview's box.
 *
 * Prefer `x / vw * width`. That stays correct when the page is zoomed,
 * because zoom changes `innerWidth` and the element's CSS size by the same
 * ratio. Multiplying by zoom on top of that would place the cursor twice
 * as far as the click. Zoom is only used when the guest did not report a
 * viewport size.
 */
export function placeAgentPointer(input: {
  x?: number
  y?: number
  vw?: number
  vh?: number
  zoom?: number
  width: number
  height: number
}): PointerPlacement {
  const width = input.width
  const height = input.height
  const hasBox = Number.isFinite(width) && Number.isFinite(height) && width >= 32 && height >= 32
  const x = input.x
  const y = input.y
  if (!finite(x) || !finite(y)) {
    return {
      x: null,
      y: null,
      centered: true,
      clamped: false,
      labelSide: 'right',
      ready: hasBox
    }
  }
  if (!hasBox) {
    return {
      x: null,
      y: null,
      centered: false,
      clamped: false,
      labelSide: 'right',
      ready: false
    }
  }

  let px: number
  let py: number
  if (finite(input.vw) && input.vw > 0 && finite(input.vh) && input.vh > 0) {
    px = (x / input.vw) * width
    py = (y / input.vh) * height
  } else {
    const zoom = finite(input.zoom) && input.zoom > 0 && input.zoom <= 8 ? input.zoom : 1
    px = x * zoom
    py = y * zoom
  }

  const maxX = Math.max(MARGIN, width - MARGIN)
  const maxY = Math.max(MARGIN, height - MARGIN)
  const clamped = px < MARGIN || py < MARGIN || px > maxX || py > maxY
  const cx = Math.min(maxX, Math.max(MARGIN, px))
  const cy = Math.min(maxY, Math.max(MARGIN, py))
  return {
    x: cx,
    y: cy,
    centered: false,
    clamped,
    labelSide: cx > width * 0.62 ? 'left' : 'right',
    ready: true
  }
}
