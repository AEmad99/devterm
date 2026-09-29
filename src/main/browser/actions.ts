/**
 * High-level agent browser actions: CDP-first with DOM fallback.
 *
 * Tools call these helpers so click/type/fill/hover/key share one
 * reliability path (resolve ref → cursor → CDP → settle / verify).
 */

import { webContents } from 'electron'
import type { BrowserControlService, BrowserTabEntry } from './control'
import {
  cdpClickAt,
  cdpHoverAt,
  cdpInsertText,
  cdpPressKey,
  SYNTHETIC_FALLBACK_NOTE
} from './cdp-input'
import {
  buildClickScript,
  buildFillScript,
  buildHoverScript,
  buildKeyPressScript,
  buildPasswordProbeScript,
  buildReadValueScript,
  buildResolveRefScript,
  buildSelectScript,
  buildTypeScript,
  parseInteraction,
  staleRefError,
  type InteractionOutcome
} from './interact'
import { buildSnapshotScript, formatOutline, parseSnapshot, type OutlineNode } from './snapshot'
import { formatObsAppendix } from './observers'

export interface ActionResult {
  ok: boolean
  text: string
  isError?: boolean
  /** When a stale ref was remapped via role/name match. */
  remappedRef?: string
}

function guest(entry: BrowserTabEntry) {
  const wc = webContents.fromId(entry.wcId)
  if (!wc || wc.isDestroyed()) return null
  return wc
}

function withObs(entry: BrowserTabEntry, body: string, opts?: { console?: boolean }): string {
  return body + formatObsAppendix(entry.wcId, opts)
}

function flattenRefs(
  node: OutlineNode | null | undefined,
  out: Map<string, { role: string; name: string }>
): void {
  if (!node) return
  if (node.ref) out.set(node.ref, { role: node.r, name: node.n ?? '' })
  for (const k of node.kids ?? []) flattenRefs(k, out)
}

/** One automatic rematch: same role+name at a new ref after a fresh snapshot. */
export async function remapStaleRef(
  service: BrowserControlService,
  entry: BrowserTabEntry,
  oldRef: string
): Promise<string | null> {
  const prev = service.getRefMeta(entry.tabKey, oldRef)
  if (!prev) return null
  try {
    const raw = await service.executeJs<string>(entry, buildSnapshotScript())
    const payload = parseSnapshot(raw)
    service.rememberSnapshot(entry.tabKey, payload)
    const map = new Map<string, { role: string; name: string }>()
    flattenRefs(payload.root, map)
    for (const [ref, meta] of map) {
      if (ref === oldRef) continue
      if (meta.role === prev.role && meta.name === prev.name && meta.name) return ref
    }
  } catch {
    /* ignore */
  }
  return null
}

/** Glide time when the cursor has a real target. Shorter when the cue is centered. */
const POINTER_LEAD_MS = 220
const POINTER_REVEAL_MS = 120

interface AimPoint {
  x?: number
  y?: number
  vw?: number
  vh?: number
}

function finite(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n)
}

/** Guest CSS pixels only. Missing or NaN coords are omitted so we never click the corner. */
function pointOf(o: InteractionOutcome): AimPoint {
  const point: AimPoint = {}
  if (finite(o.x) && finite(o.y)) {
    point.x = o.x
    point.y = o.y
  }
  if (finite(o.vw) && o.vw > 0) point.vw = o.vw
  if (finite(o.vh) && o.vh > 0) point.vh = o.vh
  return point
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Reveal the pane and move the cursor. Always waits so the operator can see it land. */
async function aim(
  service: BrowserControlService,
  entry: BrowserTabEntry,
  point: AimPoint,
  label: string
): Promise<void> {
  service.showPointer(entry, { kind: 'move', ...point, label })
  const hasPoint = point.x !== undefined && point.y !== undefined
  await delay(hasPoint ? POINTER_LEAD_MS : POINTER_REVEAL_MS)
}

async function resolveCoords(
  service: BrowserControlService,
  entry: BrowserTabEntry,
  ref: string
): Promise<InteractionOutcome> {
  return parseInteraction(await service.executeJs(entry, buildResolveRefScript(ref)))
}

export async function actionClick(
  service: BrowserControlService,
  entry: BrowserTabEntry,
  ref: string,
  triedRemap = false
): Promise<ActionResult> {
  const wc = guest(entry)
  if (!wc)
    return {
      ok: false,
      isError: true,
      text: "the tab's page is no longer running (was it closed?)"
    }

  const resolved = await resolveCoords(service, entry, ref)
  if (resolved.err?.includes('no longer exists') && !triedRemap) {
    const next = await remapStaleRef(service, entry, ref)
    if (next) {
      const r = await actionClick(service, entry, next, true)
      return { ...r, remappedRef: next, text: `remapped ${ref}→${next}; ${r.text}` }
    }
    return { ok: false, isError: true, text: withObs(entry, resolved.err || staleRefError(ref)) }
  }
  if (resolved.err) return { ok: false, isError: true, text: withObs(entry, resolved.err) }

  const point = pointOf(resolved)
  if (point.x === undefined || point.y === undefined) {
    return {
      ok: false,
      isError: true,
      text: withObs(entry, 'element has no viewport coordinates — run browser_snapshot and retry')
    }
  }
  await aim(service, entry, point, 'Click')
  const cdp = await cdpClickAt(wc, point.x, point.y)
  if (cdp.ok) {
    service.showPointer(entry, { kind: 'click', ...point, label: 'Click' })
    const settled = await service.waitForSettle(entry, 4000)
    return {
      ok: true,
      text: withObs(
        entry,
        `clicked ${ref}${resolved.tag ? ` (${resolved.tag})` : ''}` +
          (settled === 'timeout' ? '\n(note: page may still be settling)' : '')
      )
    }
  }

  // DOM fallback
  const out = parseInteraction(await service.executeJs(entry, buildClickScript(ref)))
  if (out.err) return { ok: false, isError: true, text: withObs(entry, out.err) }
  service.showPointer(entry, { kind: 'click', ...point, ...pointOf(out), label: 'Click' })
  const settled = await service.waitForSettle(entry, 4000)
  return {
    ok: true,
    text: withObs(
      entry,
      `clicked ${ref}${out.detail ? ` (${out.detail})` : ''} ${SYNTHETIC_FALLBACK_NOTE}` +
        (settled === 'timeout' ? '\n(note: page may still be settling)' : '')
    )
  }
}

export async function actionHover(
  service: BrowserControlService,
  entry: BrowserTabEntry,
  ref: string
): Promise<ActionResult> {
  const wc = guest(entry)
  if (!wc)
    return {
      ok: false,
      isError: true,
      text: "the tab's page is no longer running (was it closed?)"
    }
  const resolved = await resolveCoords(service, entry, ref)
  if (resolved.err) return { ok: false, isError: true, text: withObs(entry, resolved.err) }
  const point = pointOf(resolved)
  if (point.x === undefined || point.y === undefined) {
    return {
      ok: false,
      isError: true,
      text: withObs(entry, 'element has no viewport coordinates — run browser_snapshot and retry')
    }
  }
  await aim(service, entry, point, 'Hover')
  const cdp = await cdpHoverAt(wc, point.x, point.y)
  if (cdp.ok) {
    service.showPointer(entry, { kind: 'hover', ...point, label: 'Hover' })
    return {
      ok: true,
      text: withObs(entry, `hovered ${ref}${resolved.tag ? ` (${resolved.tag})` : ''}`)
    }
  }
  const out = parseInteraction(await service.executeJs(entry, buildHoverScript(ref)))
  if (out.err) return { ok: false, isError: true, text: withObs(entry, out.err) }
  service.showPointer(entry, { kind: 'hover', ...point, ...pointOf(out), label: 'Hover' })
  return {
    ok: true,
    text: withObs(entry, `${out.detail ?? `hovered ${ref}`} ${SYNTHETIC_FALLBACK_NOTE}`)
  }
}

export async function actionFill(
  service: BrowserControlService,
  entry: BrowserTabEntry,
  ref: string,
  text: string,
  submit: boolean,
  allowPassword: boolean,
  triedRemap = false
): Promise<ActionResult & { passwordField?: boolean }> {
  const wc = guest(entry)
  if (!wc)
    return {
      ok: false,
      isError: true,
      text: "the tab's page is no longer running (was it closed?)"
    }

  // Password probe first when not yet allowed.
  if (!allowPassword) {
    const probe = parseInteraction(await service.executeJs(entry, buildPasswordProbeScript(ref)))
    if (probe.err?.includes('no longer exists') && !triedRemap) {
      const next = await remapStaleRef(service, entry, ref)
      if (next) {
        const r = await actionFill(service, entry, next, text, submit, allowPassword, true)
        return { ...r, remappedRef: next, text: `remapped ${ref}→${next}; ${r.text}` }
      }
      return { ok: false, isError: true, text: withObs(entry, probe.err || staleRefError(ref)) }
    }
    if (probe.err) return { ok: false, isError: true, text: withObs(entry, probe.err) }
    if (probe.passwordField) return { ok: false, passwordField: true, text: 'password field' }
  }

  const prepared = parseInteraction(
    await service.executeJs(entry, buildFillScript(ref, text, false, allowPassword, 'prepare'))
  )
  if (prepared.err) return { ok: false, isError: true, text: withObs(entry, prepared.err) }
  if (prepared.passwordField) return { ok: false, passwordField: true, text: 'password field' }

  const label = submit ? 'Submit' : 'Type'
  const point = pointOf(prepared)
  await aim(service, entry, point, label)
  if (point.x === undefined || point.y === undefined) {
    return {
      ok: false,
      isError: true,
      text: withObs(entry, 'field has no viewport coordinates — run browser_snapshot and retry')
    }
  }
  const cdp = await cdpInsertText(wc, text)
  if (cdp.ok) {
    service.showPointer(entry, { kind: 'type', ...point, label })
    if (submit) {
      const key = await cdpPressKey(wc, 'Enter')
      if (!key.ok) {
        // requestSubmit via DOM if Enter CDP failed
        await service.executeJs(entry, buildFillScript(ref, text, true, allowPassword, 'full'))
      }
    }
    const verify = parseInteraction(await service.executeJs(entry, buildReadValueScript(ref)))
    return {
      ok: true,
      text: withObs(
        entry,
        `filled ${ref}${submit ? ' + submitted' : ''}${verify.value !== undefined ? ` (value="${verify.value.slice(0, 60)}")` : ''}`
      )
    }
  }

  const out = parseInteraction(
    await service.executeJs(entry, buildFillScript(ref, text, submit, allowPassword, 'full'))
  )
  if (out.err) return { ok: false, isError: true, text: withObs(entry, out.err) }
  service.showPointer(entry, { kind: 'type', ...point, ...pointOf(out), label })
  return {
    ok: true,
    text: withObs(
      entry,
      `filled ${ref}${submit ? ' + submitted' : ''}${out.detail ? ` (${out.detail})` : ''} ${SYNTHETIC_FALLBACK_NOTE}`
    )
  }
}

/** Type routes through fill (same reliability path). */
export async function actionType(
  service: BrowserControlService,
  entry: BrowserTabEntry,
  ref: string,
  text: string,
  submit: boolean,
  allowPassword: boolean
): Promise<ActionResult & { passwordField?: boolean }> {
  // Prefer fill path; if prepare fails oddly, fall back to classic type script once.
  const r = await actionFill(service, entry, ref, text, submit, allowPassword)
  if (r.passwordField || r.ok || r.isError) return r
  const out = parseInteraction(
    await service.executeJs(entry, buildTypeScript(ref, text, submit, allowPassword))
  )
  if (out.passwordField) return { ok: false, passwordField: true, text: 'password field' }
  if (out.err) return { ok: false, isError: true, text: withObs(entry, out.err) }
  service.showPointer(entry, {
    kind: 'type',
    ...pointOf(out),
    label: submit ? 'Submit' : 'Type'
  })
  return {
    ok: true,
    text: withObs(
      entry,
      `typed into ${ref}${submit ? ' + submitted' : ''} ${SYNTHETIC_FALLBACK_NOTE}`
    )
  }
}

export async function actionSelect(
  service: BrowserControlService,
  entry: BrowserTabEntry,
  ref: string,
  opts: { value?: string; label?: string; index?: number }
): Promise<ActionResult> {
  await aim(service, entry, {}, 'Select')
  const out = parseInteraction(await service.executeJs(entry, buildSelectScript(ref, opts)))
  if (out.err) return { ok: false, isError: true, text: withObs(entry, out.err) }
  service.showPointer(entry, { kind: 'click', ...pointOf(out), label: 'Select' })
  return { ok: true, text: withObs(entry, out.detail ?? `selected on ${ref}`) }
}

export async function actionPressKey(
  service: BrowserControlService,
  entry: BrowserTabEntry,
  key: string,
  ref?: string
): Promise<ActionResult> {
  const wc = guest(entry)
  if (!wc)
    return {
      ok: false,
      isError: true,
      text: "the tab's page is no longer running (was it closed?)"
    }

  let point: AimPoint = {}
  if (ref) {
    const resolved = await resolveCoords(service, entry, ref)
    if (resolved.err) return { ok: false, isError: true, text: withObs(entry, resolved.err) }
    point = pointOf(resolved)
    if (point.x === undefined || point.y === undefined) {
      return {
        ok: false,
        isError: true,
        text: withObs(entry, 'element has no viewport coordinates — run browser_snapshot and retry')
      }
    }
    await aim(service, entry, point, key)
  } else {
    await aim(service, entry, {}, key)
  }

  const cdp = await cdpPressKey(wc, key)
  if (cdp.ok) {
    service.showPointer(entry, { kind: 'key', ...point, label: key })
    return {
      ok: true,
      text: withObs(entry, `sent ${key}${ref ? ` to ${ref}` : ''}`)
    }
  }
  const out = parseInteraction(await service.executeJs(entry, buildKeyPressScript(key, ref)))
  if (out.err) return { ok: false, isError: true, text: withObs(entry, out.err) }
  service.showPointer(entry, { kind: 'key', ...point, label: key })
  return {
    ok: true,
    text: withObs(entry, `${out.detail ?? `sent ${key}`} ${SYNTHETIC_FALLBACK_NOTE}`)
  }
}

export async function actionSnapshot(
  service: BrowserControlService,
  entry: BrowserTabEntry,
  maxChars: number
): Promise<ActionResult> {
  const raw = await service.executeJs<string>(entry, buildSnapshotScript())
  const payload = parseSnapshot(raw)
  service.rememberSnapshot(entry.tabKey, payload)
  const outline = formatOutline(payload, maxChars)
  return {
    ok: true,
    text: withObs(entry, outline, { console: true })
  }
}
