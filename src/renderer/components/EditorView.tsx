import { useEffect, useRef } from 'react'
import { EditorState, type Extension } from '@codemirror/state'
import { EditorView as CMView, keymap } from '@codemirror/view'
import { indentWithTab } from '@codemirror/commands'
import { basicSetup } from 'codemirror'
import { oneDark } from '@codemirror/theme-one-dark'
import { useEditors, type EditorDoc } from '../store/editors'
import { languageFor } from '../lib/cm-languages'
import { IconLocal, IconRemote } from './Icons'

/**
 * The editor surface: a tab strip for open docs plus the CodeMirror view for the
 * active one. Mounted whenever at least one file is open and the editor area has
 * focus; App hides the session panes underneath it.
 */
export default function EditorView() {
  const docs = useEditors((s) => s.docs)
  const activeId = useEditors((s) => s.activeId)
  const save = useEditors((s) => s.save)
  const active = docs.find((d) => d.id === activeId) || null

  if (!active) return null
  const dirty = active.state === 'ready' && active.content !== active.savedContent

  return (
    <div className="editor-area">
      <div className="editor-toolbar">
        <span
          className="editor-scope"
          title={active.scope === 'remote' ? 'Remote (SFTP)' : 'Local'}
        >
          {active.scope === 'remote' ? <IconRemote size={14} /> : <IconLocal size={14} />}
        </span>
        <code className="editor-path" title={active.path}>
          {active.path}
        </code>
        {dirty && (
          <span className="editor-dirty" title="Unsaved changes">
            ●
          </span>
        )}
        <span className="spacer" />
        {active.error && active.state === 'ready' && (
          <span className="editor-toolbar-error" title={active.error}>
            ⚠ save failed
          </span>
        )}
        <button
          className="primary"
          disabled={!dirty || active.saving}
          onClick={() => save(active.id)}
        >
          {active.saving ? 'Saving…' : 'Save (Ctrl+S)'}
        </button>
      </div>
      {active.state === 'loading' && <div className="editor-status">Loading {active.name}…</div>}
      {active.state === 'error' && (
        <div className="editor-status editor-status-error">
          Could not open {active.name}
          <div className="editor-status-detail">{active.error}</div>
        </div>
      )}
      {active.state === 'ready' && <CodeMirror key={active.id} doc={active} />}
    </div>
  )
}

/** One CodeMirror instance bound to a single ready doc (remounts per doc via key). */
function CodeMirror({ doc }: { doc: EditorDoc }) {
  const host = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<CMView | null>(null)
  const setContent = useEditors((s) => s.setContent)
  const save = useEditors((s) => s.save)

  // Stable callbacks for the CM extensions (which are built once on mount).
  const cb = useRef({ id: doc.id, setContent, save })
  cb.current = { id: doc.id, setContent, save }

  useEffect(() => {
    if (!host.current) return
    const extensions: Extension[] = [
      basicSetup,
      oneDark,
      keymap.of([
        indentWithTab,
        {
          key: 'Mod-s',
          preventDefault: true,
          run: () => {
            void cb.current.save(cb.current.id)
            return true
          }
        }
      ]),
      languageFor(doc.name),
      CMView.updateListener.of((u) => {
        if (u.docChanged) cb.current.setContent(cb.current.id, u.state.doc.toString())
      })
    ]
    const view = new CMView({
      state: EditorState.create({ doc: doc.content, extensions }),
      parent: host.current
    })
    viewRef.current = view
    view.focus()
    return () => {
      view.destroy()
      viewRef.current = null
    }
    // Built once per mounted doc; doc.content here is the loaded baseline.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return <div className="cm-host" ref={host} />
}
