/**
 * Trusted CDP Input for agent browser control.
 *
 * Attaches Electron's Chrome DevTools Protocol debugger to a guest
 * webContents and dispatches mouse/keyboard events with isTrusted:true —
 * the phase-2 upgrade over DOM-dispatched synthetic events in interact.ts.
 *
 * When the debugger cannot attach (operator DevTools open, guest gone),
 * callers fall back to DOM scripts and tag the result accordingly.
 */

import type { WebContents } from 'electron'

export type CdpResult =
  | { ok: true }
  | { ok: false; reason: 'unavailable' | 'failed'; detail: string }

/** Per-wcId attach bookkeeping so we don't re-attach on every click. */
const attached = new Set<number>()

function wcIdOf(wc: WebContents): number {
  return wc.id
}

/**
 * Ensure the debugger is attached. Returns false when attach is impossible
 * (already taken by DevTools, destroyed guest, etc.).
 */
export function ensureDebugger(wc: WebContents): boolean {
  if (!wc || wc.isDestroyed()) return false
  const id = wcIdOf(wc)
  if (attached.has(id) && wc.debugger.isAttached()) return true
  try {
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3')
    attached.add(id)
    // Auto-clean if Chromium detaches underneath us (DevTools opened).
    wc.debugger.removeAllListeners('detach')
    wc.debugger.on('detach', () => {
      attached.delete(id)
    })
    return true
  } catch {
    attached.delete(id)
    return false
  }
}

/** Detach and forget — call on tab unregister. */
export function detachDebugger(wc: WebContents | null | undefined): void {
  if (!wc || wc.isDestroyed()) return
  const id = wcIdOf(wc)
  try {
    if (wc.debugger.isAttached()) wc.debugger.detach()
  } catch {
    /* already gone */
  }
  attached.delete(id)
}

export function forgetDebugger(wcId: number): void {
  attached.delete(wcId)
}

async function send(wc: WebContents, method: string, params: Record<string, unknown>): Promise<void> {
  await wc.debugger.sendCommand(method, params)
}

export async function cdpClickAt(
  wc: WebContents,
  x: number,
  y: number,
  button: 'left' | 'right' | 'middle' = 'left'
): Promise<CdpResult> {
  if (!ensureDebugger(wc)) return { ok: false, reason: 'unavailable', detail: 'debugger attach failed' }
  try {
    const common = { x, y, button, clickCount: 1, modifiers: 0 }
    await send(wc, 'Input.dispatchMouseEvent', { type: 'mouseMoved', ...common })
    await send(wc, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...common })
    await send(wc, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...common })
    return { ok: true }
  } catch (e) {
    return { ok: false, reason: 'failed', detail: (e as Error).message }
  }
}

export async function cdpHoverAt(wc: WebContents, x: number, y: number): Promise<CdpResult> {
  if (!ensureDebugger(wc)) return { ok: false, reason: 'unavailable', detail: 'debugger attach failed' }
  try {
    await send(wc, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x,
      y,
      button: 'none',
      modifiers: 0
    })
    return { ok: true }
  } catch (e) {
    return { ok: false, reason: 'failed', detail: (e as Error).message }
  }
}

/** Insert unicode text at the focused element (preferred for typing). */
export async function cdpInsertText(wc: WebContents, text: string): Promise<CdpResult> {
  if (!ensureDebugger(wc)) return { ok: false, reason: 'unavailable', detail: 'debugger attach failed' }
  try {
    await send(wc, 'Input.insertText', { text })
    return { ok: true }
  } catch (e) {
    return { ok: false, reason: 'failed', detail: (e as Error).message }
  }
}

export interface KeySpec {
  key: string
  code: string
  windowsVirtualKeyCode: number
  nativeVirtualKeyCode?: number
  text?: string
  unmodifiedText?: string
}

const KEY_MAP: Record<string, KeySpec> = {
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  Esc: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  Home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 },
  End: { key: 'End', code: 'End', windowsVirtualKeyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 },
  Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' }
}

export interface ParsedKeyCombo {
  key: string
  modifiers: number // CDP bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8
  spec: KeySpec
}

/**
 * Parse "Control+Enter", "Ctrl+A", "Shift+Tab", "Escape", "a", etc.
 * Modifier names are case-insensitive; the final key keeps its casing for letters.
 */
export function parseKeyCombo(raw: string): ParsedKeyCombo | { err: string } {
  const parts = String(raw)
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean)
  if (!parts.length) return { err: 'empty key' }
  let modifiers = 0
  const keyPart = parts[parts.length - 1]
  for (const p of parts.slice(0, -1)) {
    const m = p.toLowerCase()
    if (m === 'ctrl' || m === 'control') modifiers |= 2
    else if (m === 'alt' || m === 'option') modifiers |= 1
    else if (m === 'shift') modifiers |= 8
    else if (m === 'meta' || m === 'cmd' || m === 'command' || m === 'win') modifiers |= 4
    else return { err: `unknown modifier: ${p}` }
  }
  const named = KEY_MAP[keyPart] || KEY_MAP[keyPart.replace(/^Arrow/i, 'Arrow')]
  if (named) return { key: named.key, modifiers, spec: named }
  if (keyPart.length === 1) {
    const ch = keyPart
    const upper = ch.toUpperCase()
    const code =
      /[a-zA-Z]/.test(ch)
        ? `Key${upper}`
        : /[0-9]/.test(ch)
          ? `Digit${ch}`
          : ch
    const vk = /[a-zA-Z]/.test(ch)
      ? upper.charCodeAt(0)
      : /[0-9]/.test(ch)
        ? 48 + Number(ch)
        : ch.charCodeAt(0)
    return {
      key: ch,
      modifiers,
      spec: {
        key: ch,
        code,
        windowsVirtualKeyCode: vk,
        text: ch,
        unmodifiedText: ch
      }
    }
  }
  // Fall through: use the raw string as key/code.
  return {
    key: keyPart,
    modifiers,
    spec: { key: keyPart, code: keyPart, windowsVirtualKeyCode: 0, text: keyPart.length === 1 ? keyPart : undefined }
  }
}

export async function cdpPressKey(wc: WebContents, raw: string): Promise<CdpResult> {
  if (!ensureDebugger(wc)) return { ok: false, reason: 'unavailable', detail: 'debugger attach failed' }
  const parsed = parseKeyCombo(raw)
  if ('err' in parsed) return { ok: false, reason: 'failed', detail: parsed.err }
  const { spec, modifiers } = parsed
  try {
    const base = {
      windowsVirtualKeyCode: spec.windowsVirtualKeyCode,
      code: spec.code,
      key: spec.key,
      modifiers,
      text: spec.text ?? '',
      unmodifiedText: spec.unmodifiedText ?? spec.text ?? ''
    }
    await send(wc, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base })
    if (spec.text) {
      await send(wc, 'Input.dispatchKeyEvent', { type: 'char', ...base })
    }
    await send(wc, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base })
    return { ok: true }
  } catch (e) {
    return { ok: false, reason: 'failed', detail: (e as Error).message }
  }
}

/** Tag appended to tool results when CDP was unavailable and DOM events were used. */
export const SYNTHETIC_FALLBACK_NOTE = '(synthetic input fallback)'
