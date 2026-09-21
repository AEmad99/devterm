/** Live CodeMirror views keyed by editor doc id. Kept out of EditorView so the
 * command palette can read a selection without loading the editor chunk. */
interface SelectionView {
  state: {
    selection: { main: { empty: boolean; from: number; to: number } }
    sliceDoc: (from: number, to: number) => string
    doc: { toString: () => string }
  }
  requestMeasure?: () => void
}

const viewRegistry = new Map<string, SelectionView>()

export function registerEditorView(id: string, view: SelectionView): void {
  viewRegistry.set(id, view)
}

export function unregisterEditorView(id: string): void {
  viewRegistry.delete(id)
}

export function getEditorView(id: string): SelectionView | undefined {
  return viewRegistry.get(id)
}

export function getEditorSelection(activeId: string | null | undefined): string {
  if (!activeId) return ''
  const view = viewRegistry.get(activeId)
  if (!view) return ''
  const sel = view.state.selection.main
  if (sel.empty) return ''
  return view.state.sliceDoc(sel.from, sel.to)
}
