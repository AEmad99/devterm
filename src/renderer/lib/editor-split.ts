import type { EditorSplit } from '../store/editors'

/** Fraction of the editor/terminal split given to the file side. */
export const EDITOR_SPLIT_MIN = 0.18
export const EDITOR_SPLIT_MAX = 0.82

export function clampEditorSplitRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0.5
  return Math.min(EDITOR_SPLIT_MAX, Math.max(EDITOR_SPLIT_MIN, ratio))
}

/**
 * Keep a split pointed at documents that are still open. A missing secondary
 * file falls back to the terminal pane. No documents means no split.
 */
export function reconcileEditorSplit(
  split: EditorSplit | null,
  docIds: string[],
  activeId: string | null
): EditorSplit | null {
  if (!split || docIds.length === 0) return null
  let primaryId = split.primaryId
  if (!docIds.includes(primaryId)) {
    primaryId = activeId && docIds.includes(activeId) ? activeId : docIds[docIds.length - 1]
  }
  let other = split.other
  if (other !== 'terminal' && (other === primaryId || !docIds.includes(other))) {
    other = 'terminal'
  }
  const ratio = clampEditorSplitRatio(split.ratio)
  if (primaryId === split.primaryId && other === split.other && ratio === split.ratio) return split
  return { ...split, primaryId, other, ratio }
}

/** Build the next split, keeping the ratio when the direction stays the same. */
export function withEditorSplit(
  current: EditorSplit | null,
  dir: 'row' | 'col',
  primaryId: string,
  other: 'terminal' | string
): EditorSplit {
  const ratio = current && current.dir === dir ? clampEditorSplitRatio(current.ratio) : 0.5
  if (other !== 'terminal' && other === primaryId) {
    return { dir, ratio, primaryId, other: 'terminal' }
  }
  return { dir, ratio, primaryId, other }
}

/** Newest other document, if the operator has more than one file open. */
export function otherOpenDoc(docIds: string[], primaryId: string): string | null {
  for (let i = docIds.length - 1; i >= 0; i--) {
    if (docIds[i] !== primaryId) return docIds[i]
  }
  return null
}
