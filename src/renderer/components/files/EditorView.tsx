import { useEffect, useRef, useState } from 'react'
import { EditorState, type Extension } from '@codemirror/state'
import { EditorView as CMView, keymap } from '@codemirror/view'
import { indentWithTab } from '@codemirror/commands'
import { basicSetup } from 'codemirror'
import { oneDark } from '@codemirror/theme-one-dark'
import { useEditors, type EditorDoc } from '../../store/editors'
import { useSessions } from '../../store/sessions'
import { languageFor } from '../../lib/cm-languages'
import { sendTerminalInput } from '../../lib/terms'
import { IconLocal, IconRemote } from '../common/Icons'

/**
 * The "Run in terminal" feature: pipe the current selection (or full doc) to
 * the active terminal through the existing input pipeline (see lib/terms). The
 * language pick is cosmetic for v1 — it just chooses the trailing line
 * terminator (\n for sh/bash/python/node/sql, \r for ps1, since PowerShell
 * reads input lines terminated by CR). We never open a new channel.
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
  const active = docs.find((d) => d.id === activeId) || null
  const activeSession = useSessions((s) =>
    active
      ? (s.sessions.find(
          (x) => x.id === (active.scope === 'remote' ? active.sessionId : s.activeId)
        ) ?? null)
      : null
  )
  // The Run language preference lives in component state — v1 keeps it
  // per-session-in-the-head and is not persisted. (Task spec marks this as
  // cosmetic; promote to a real setting later if it sticks.)
  const [runLang, setRunLang] = useState<RunLang>(active ? defaultRunLang(active.name) : 'sh')
  useEffect(() => {
    if (active) setRunLang(defaultRunLang(active.name))
  }, [active])

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
    const lang = RUN_LANGS.find((l) => l.id === runLang) ?? RUN_LANGS[0]
    const payload = normalized.endsWith(lang.eol) ? normalized : normalized + lang.eol
    sendTerminalInput(activeSession.id, payload)
  }

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
        <select
          className="editor-run-lang"
          value={runLang}
          onChange={(e) => setRunLang(e.target.value as RunLang)}
          title="Run as (cosmetic — only affects the line terminator)"
        >
          {RUN_LANGS.map((l) => (
            <option key={l.id} value={l.id}>
              {l.label}
            </option>
          ))}
        </select>
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
      {active.state === 'ready' && <CodeMirror key={active.id} doc={active} />}
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
    viewRegistry.set(doc.id, view)
    view.focus()
    return () => {
      viewRegistry.delete(doc.id)
      view.destroy()
      viewRef.current = null
    }
    // Built once per mounted doc; doc.content here is the loaded baseline.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return <div className="cm-host" ref={host} />
}
