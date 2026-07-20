import { useEffect, useLayoutEffect, useRef } from 'react'
import { EditorState, StateEffect, type Extension } from '@codemirror/state'
import { EditorView as CMView, keymap } from '@codemirror/view'
import { indentWithTab } from '@codemirror/commands'
import { basicSetup } from 'codemirror'
import { oneDark } from '@codemirror/theme-one-dark'
import { useEditors, type EditorDoc } from '../../store/editors'
import { useSessions } from '../../store/sessions'
import { sendTerminalInput } from '../../lib/terms'
import { isMarkdownName } from '../../lib/markdown-preview'
import { IconLocal, IconRemote, IconTerminals } from '../common/Icons'
import MarkdownPreview from './MarkdownPreview'

/**
 * The "Run in terminal" feature: pipe the current selection (or full doc) to
 * the active terminal through the existing input pipeline (see lib/terms). The
 * run language is inferred from the file extension and only affects the
 * trailing line terminator (\n for sh/bash/python/node/sql, \r for ps1, since
 * PowerShell reads input lines terminated by CR). We never open a new channel.
 */
type RunLang = 'sh' | 'bash' | 'python' | 'node' | 'ps1' | 'sql'

const RUN_LANGS: { id: RunLang; label: string; eol: '\n' | '\r' }[] = [
  { id: 'sh', label: 'sh', eol: '\n' },
  { id: 'bash', label: 'bash', eol: '\n' },
  { id: 'python', label: 'python', eol: '\n' },
  { id: 'node', label: 'node', eol: '\n' },
  { id: 'ps1', label: 'ps1', eol: '\r' },
  { id: 'sql', label: 'sql', eol: '\n' }
]

function defaultRunLang(name: string): RunLang {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  if (ext === 'py') return 'python'
  if (ext === 'js' || ext === 'mjs' || ext === 'cjs' || ext === 'ts') return 'node'
  if (ext === 'ps1' || ext === 'psm1') return 'ps1'
  if (ext === 'sql') return 'sql'
  if (ext === 'bash' || ext === 'zsh') return 'bash'
  return 'sh'
}

export default function EditorView() {
  const docs = useEditors((s) => s.docs)
  const activeId = useEditors((s) => s.activeId)
  const save = useEditors((s) => s.save)
  const setPreviewMode = useEditors((s) => s.setPreviewMode)
  const editorBlur = useEditors((s) => s.blur)
  const active = docs.find((d) => d.id === activeId) || null
  const activeSession = useSessions((s) =>
    active
      ? (s.sessions.find(
          (x) => x.id === (active.scope === 'remote' ? active.sessionId : s.activeId)
        ) ?? null)
      : null
  )

  const isMarkdown = isMarkdownName(active?.name ?? '')
  const previewMode = isMarkdown ? active?.previewMode || 'edit' : 'edit'
  const sourceHidden = isMarkdown && previewMode === 'preview'

  const activeDocId = active?.id

  // After leaving Markdown preview-only mode, CodeMirror's viewport can be empty
  // because the editor was zero-box hidden. Force a measure once layout restores.
  useLayoutEffect(() => {
    if (!activeDocId || sourceHidden) return
    const raf = requestAnimationFrame(() => {
      viewRegistry.get(activeDocId)?.requestMeasure()
    })
    return () => cancelAnimationFrame(raf)
  }, [activeDocId, sourceHidden])

  if (!active) return null
  const dirty = active.state === 'ready' && active.content !== active.savedContent

  const runInTerminal = () => {
    if (active.state !== 'ready' || !activeSession) return
    const view = viewRegistry.get(active.id)
    if (!view) return
    // Selection wins, full doc otherwise. Don't trim the user's text — they
    // may have carefully formatted a script and we should not collapse it.
    const sel = view.state.selection.main
    const text = sel.empty ? view.state.doc.toString() : view.state.sliceDoc(sel.from, sel.to)
    if (!text) return
    // Normalize CRLF to LF so the receiving shell (POSIX, Windows pwsh both)
    // sees a consistent line ending. We do this BEFORE the language-specific
    // terminator so a single \n is the canonical "send a line" boundary; the
    // trailing terminator is then re-applied per lang.
    const normalized = text.replace(/\r\n?/g, '\n')
    const runLang = defaultRunLang(active.name)
    const lang = RUN_LANGS.find((l) => l.id === runLang) ?? RUN_LANGS[0]
    const payload = normalized.endsWith(lang.eol) ? normalized : normalized + lang.eol
    sendTerminalInput(activeSession.id, payload)
  }

  return (
    <div className="editor-area">
      <div className="editor-toolbar">
        <button
          className="editor-back"
          onClick={editorBlur}
          title="Back to terminals (Esc)"
          aria-label="Back to terminals"
        >
          <IconTerminals size={14} />
          <span className="editor-back-label">Terminals</span>
        </button>
        <span className="editor-toolbar-sep" aria-hidden="true" />
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
        {isMarkdown && (
          <>
            <button
              type="button"
              className={`toggle ${previewMode === 'side' ? 'active' : ''}`}
              aria-pressed={previewMode === 'side'}
              title="Side-by-side preview"
              onClick={() => setPreviewMode(active.id, previewMode === 'side' ? 'edit' : 'side')}
            >
              Side
            </button>
            <button
              type="button"
              className={`toggle ${previewMode === 'preview' ? 'active' : ''}`}
              aria-pressed={previewMode === 'preview'}
              title="Preview only"
              onClick={() =>
                setPreviewMode(active.id, previewMode === 'preview' ? 'edit' : 'preview')
              }
            >
              Preview
            </button>
          </>
        )}
        <button
          className="primary"
          disabled={active.state !== 'ready' || !activeSession}
          onClick={runInTerminal}
          title={
            activeSession
              ? `Pipe the current selection (or full file) into ${activeSession.title}`
              : 'No active terminal to send to'
          }
        >
          ▶ Run
        </button>
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
      {active.state === 'ready' && (
        <div className={`editor-body mode-${previewMode}`}>
          <div
            className={sourceHidden ? 'editor-source editor-source--parked' : 'editor-source'}
            aria-hidden={sourceHidden || undefined}
          >
            <CodeMirror key={active.id} doc={active} />
          </div>
          {isMarkdown && (previewMode === 'side' || previewMode === 'preview') && (
            <div className="editor-preview">
              <MarkdownPreview
                docId={active.id}
                content={active.content}
                previewMode={previewMode}
                scope={active.scope}
                path={active.path}
                sessionId={active.sessionId}
              />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** Tiny cross-component registry of live CodeMirror views by doc id, so the
 * "Run" button can reach the editor and read the current selection. */
const viewRegistry = new Map<string, CMView>()

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
    let disposed = false
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
      CMView.updateListener.of((u) => {
        if (u.docChanged) cb.current.setContent(cb.current.id, u.state.doc.toString())
      })
    ]
    const view = new CMView({
      state: EditorState.create({ doc: doc.content, extensions }),
      parent: host.current
    })
    viewRef.current = view
    viewRegistry.set(doc.id, view)
    view.focus()
    // Language parsers are the largest part of the renderer. Load the local
    // grammar pack only after an editor exists so terminal-first startup never
    // downloads/parses dozens of CodeMirror languages. The editor remains
    // usable as plain text during the short local chunk load.
    void import('../../lib/cm-languages')
      .then(({ languageFor }) => {
        if (disposed) return
        const language = languageFor(doc.name)
        if (language.length > 0) {
          view.dispatch({ effects: StateEffect.appendConfig.of(language) })
        }
      })
      .catch(() => {
        /* plain-text editing remains fully functional */
      })
    return () => {
      disposed = true
      viewRegistry.delete(doc.id)
      view.destroy()
      viewRef.current = null
    }
    // Built once per mounted doc; doc.content here is the loaded baseline.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return <div className="cm-host" ref={host} />
}
