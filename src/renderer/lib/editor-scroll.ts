/** Last scroll offset for an open file. Kept outside React so a hidden editor
 * can be shown again without jumping back to the top. */

export interface ScrollPos {
  top: number
  left: number
}

const editorScroll = new Map<string, ScrollPos>()
const previewScroll = new Map<string, ScrollPos>()

/**
 * Remember a scroll offset only while the scroller actually has a box.
 * A parked or 0-size editor reports scroll 0, and writing that down would
 * throw away the position the operator was reading.
 */
export function noteScroll(
  prev: ScrollPos | undefined,
  top: number,
  left: number,
  laidOut: boolean
): ScrollPos | undefined {
  if (!laidOut) return prev
  if (prev && prev.top === top && prev.left === left) return prev
  return { top, left }
}

function remember(
  store: Map<string, ScrollPos>,
  id: string,
  top: number,
  left: number,
  laidOut: boolean
): void {
  const next = noteScroll(store.get(id), top, left, laidOut)
  if (next && next !== store.get(id)) store.set(id, next)
}

export function rememberEditorScroll(
  id: string,
  top: number,
  left: number,
  laidOut: boolean
): void {
  remember(editorScroll, id, top, left, laidOut)
}

export function rememberPreviewScroll(
  id: string,
  top: number,
  left: number,
  laidOut: boolean
): void {
  remember(previewScroll, id, top, left, laidOut)
}

export function recallEditorScroll(id: string): ScrollPos | undefined {
  return editorScroll.get(id)
}

export function recallPreviewScroll(id: string): ScrollPos | undefined {
  return previewScroll.get(id)
}

export function forgetEditorScroll(id: string): void {
  editorScroll.delete(id)
  previewScroll.delete(id)
}

export function applyScroll(el: HTMLElement | null | undefined, pos: ScrollPos | undefined): void {
  if (!el || !pos) return
  if (el.scrollTop !== pos.top) el.scrollTop = pos.top
  if (el.scrollLeft !== pos.left) el.scrollLeft = pos.left
}

export function scrollerLaidOut(el: HTMLElement): boolean {
  return el.clientHeight >= 1 && el.clientWidth >= 1
}
