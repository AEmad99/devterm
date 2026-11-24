import { useEditors } from '../store/editors'
import { useSessions } from '../store/sessions'
import { DEFAULT_GROUP, useLayout } from '../store/layout'
import { otherOpenDoc, withEditorSplit } from './editor-split'

/**
 * Split should tile the open file when the editor is the active surface.
 * A terminal that currently holds DOM focus keeps the terminal split.
 */
export function editorOwnsSplit(): boolean {
  const ed = useEditors.getState()
  if (!ed.focused || !ed.activeId) return false
  if (!ed.docs.some((d) => d.id === ed.activeId)) return false
  if (typeof document === 'undefined') return true
  const el = document.activeElement as HTMLElement | null
  if (!el) return true
  if (el.classList.contains('xterm-helper-textarea') || el.closest('.terminal-host')) return false
  return true
}

function place(dir: 'row' | 'col', primaryId: string, other: 'terminal' | string): void {
  const ed = useEditors.getState()
  ed.setSplit(withEditorSplit(ed.split, dir, primaryId, other))
  ed.setActive(primaryId)
}

/** Show `primaryId` (or the active file) beside the live terminal layout. */
export function splitEditorWithTerminal(dir: 'row' | 'col', primaryId?: string): void {
  const ed = useEditors.getState()
  const id = primaryId ?? ed.activeId
  if (!id || !ed.docs.some((d) => d.id === id)) return
  if (useSessions.getState().sessions.length === 0) {
    const gid = useLayout.getState().activeGroupId || DEFAULT_GROUP
    useSessions.getState().addLocal({ groupId: gid })
  }
  place(dir, id, 'terminal')
}

/** Show `primaryId` beside another open file. No-op when it is the only file. */
export function splitEditorWithFile(dir: 'row' | 'col', primaryId?: string): void {
  const ed = useEditors.getState()
  const id = primaryId ?? ed.activeId
  if (!id) return
  const other = otherOpenDoc(
    ed.docs.map((d) => d.id),
    id
  )
  if (!other) return
  place(dir, id, other)
}

/**
 * Hotkey / command-palette entry. Returns true when the open file was tiled
 * with the terminal so the caller does not also spawn a terminal split.
 */
export function splitFocusedEditor(dir: 'row' | 'col'): boolean {
  if (!editorOwnsSplit()) return false
  splitEditorWithTerminal(dir)
  return true
}
