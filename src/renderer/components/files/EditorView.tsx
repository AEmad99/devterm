import { useEffect, useLayoutEffect, useRef } from 'react'
import { EditorState, StateEffect, type Extension } from '@codemirror/state'
import { EditorView as CMView, keymap } from '@codemirror/view'
import { indentWithTab } from '@codemirror/commands'
import { basicSetup } from 'codemirror'
import { oneDark } from '@codemirror/theme-one-dark'
import { useEditors, type EditorDoc } from '../../store/editors'
import { useSessions } from '../../store/sessions'
import { sendTerminalInput } from '../../lib/terms'
import { askAgentAboutSelection } from '../../lib/agent-selection'
import { getEditorView, registerEditorView, unregisterEditorView } from '../../lib/editor-registry'
import { isMarkdownName } from '../../lib/markdown-preview'
import { IconLocal, IconRemote, IconSplit, IconTerminals } from '../common/Icons'
import { splitEditorWithFile, splitEditorWithTerminal } from '../../lib/editor-split-actions'
import {
  applyScroll,
  recallEditorScroll,
  recallPreviewScroll,
  rememberEditorScroll,
  rememberPreviewScroll,
  scrollerLaidOut
} from '../../lib/editor-scroll'
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

export default function EditorView({
  docId,
  autoFocus = true,
  revealed = true
}: {
  /** Pin this pane to a document. Omit to follow the active document. */
  docId?: string
  autoFocus?: boolean
  /** False while this pane is parked off-screen so the terminal can be used. */
  revealed?: boolean
}) {
  const docs = useEditors((s) => s.docs)
  const activeId = useEditors((s) => s.activeId)
  const split = useEditors((s) => s.split)
  const save = useEditors((s) => s.save)
  const setPreviewMode = useEditors((s) => s.setPreviewMode)
  const editorBlur = useEditors((s) => s.blur)
  const setSplit = useEditors((s) => s.setSplit)
  const shownId = docId ?? activeId
  const active = docs.find((d) => d.id === shownId) || null
  const canSplitFile = docs.length > 1
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
  const areaRef = useRef<HTMLDivElement | null>(null)
  const revealedRef = useRef(revealed)

  const previewPane = (): HTMLElement | null =>
    areaRef.current?.querySelector<HTMLElement>('.editor-preview') ?? null

  const writePreview = (el: HTMLElement, allowOrigin: boolean) => {
    if (!activeDocId || !scrollerLaidOut(el)) return
    const top = el.scrollTop
    const left = el.scrollLeft
    // Hiding the editor can report 0 for a pane the operator had scrolled.
    // A live scroll to the top still records, because that path sets allowOrigin.
    if (!allowOrigin && top === 0 && left === 0) {
      const prev = recallPreviewScroll(activeDocId)
      if (prev && (prev.top !== 0 || prev.left !== 0)) return
    }
    rememberPreviewScroll(activeDocId, top, left, true)
  }

  const restorePreview = () => {
    if (!activeDocId) return
    applyScroll(previewPane(), recallPreviewScroll(activeDocId))
  }

  const onAreaScroll = (e: React.UIEvent<HTMLDivElement>) => {
    if (!revealed) return
    const el = e.target
    if (!(el instanceof HTMLElement) || el.classList.contains('cm-scroller')) return
    const pane = el.classList.contains('editor-preview')
      ? el
      : el.closest<HTMLElement>('.editor-preview')
    if (pane) writePreview(pane, true)
  }

  // After leaving Markdown preview-only mode, CodeMirror's viewport can be empty
  // because the editor was zero-box hidden. Force a measure once layout restores
  // and put the source back where the operator left it.
  useLayoutEffect(() => {
    if (!activeDocId || sourceHidden) return
    const raf = requestAnimationFrame(() => {
      const view = getEditorView(activeDocId)
      view?.requestMeasure?.()
      applyScroll(view?.scrollDOM, recallEditorScroll(activeDocId))
    })
    return () => cancelAnimationFrame(raf)
  }, [activeDocId, sourceHidden])

  useLayoutEffect(() => {
    restorePreview()
    // Restoring after a mode change is keyed on the doc and the preview mode.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeDocId, previewMode])

  // Coming back from the terminal must not jump the caret (or the preview)
  // to the top. The offset is captured before paint hides the pane, and focus
  // is restored only after that offset is applied.
  useLayoutEffect(() => {
    const wasRevealed = revealedRef.current
    revealedRef.current = revealed
    if (!revealed) {
      if (wasRevealed && activeDocId) {
        const scroller = getEditorView(activeDocId)?.scrollDOM
        if (scroller) {
          rememberEditorScroll(
            activeDocId,
            scroller.scrollTop,
            scroller.scrollLeft,
            scrollerLaidOut(scroller)
          )
        }
        const preview = previewPane()
        if (preview) writePreview(preview, false)
        const el = document.activeElement
        if (el instanceof HTMLElement && el.closest('.pane-editor')) el.blur()
      }
      return
    }
    if (wasRevealed || !activeDocId) return
    let cancelled = false
    const restore = () => {
      if (cancelled) return
      const view = getEditorView(activeDocId)
      applyScroll(view?.scrollDOM, recallEditorScroll(activeDocId))
      restorePreview()
    }
    restore()
    const raf = requestAnimationFrame(() => {
      restore()
      const view = getEditorView(activeDocId)
      const scroller = view?.scrollDOM
      const top = scroller?.scrollTop ?? 0
      const left = scroller?.scrollLeft ?? 0
      view?.focus?.()
      if (scroller) {
        scroller.scrollTop = top
        scroller.scrollLeft = left
      }
      requestAnimationFrame(restore)
    })
    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
    }
    // restorePreview / writePreview close over the doc id already listed here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealed, activeDocId])

  if (!active) return null
  const dirty = active.state === 'ready' && active.content !== active.savedContent

  const runInTerminal = () => {
    if (active.state !== 'ready' || !activeSession) return
    const view = getEditorView(active.id)
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

  const askAgent = () => {
    if (active.state !== 'ready' || !activeSession || activeSession.kind === 'browser') return
    const view = getEditorView(active.id)
    if (!view) return
    const sel = view.state.selection.main
    const text = sel.empty ? '' : view.state.sliceDoc(sel.from, sel.to)
    void askAgentAboutSelection({
      sessionId: activeSession.id,
      selection: text,
      source: 'editor'
    })
  }

  return (
    <div className="editor-area" ref={areaRef} onScrollCapture={onAreaScroll}>
      <div className="editor-toolbar">
        <button
          className="editor-back"
          onClick={() => {
            setSplit(null)
            editorBlur()
          }}
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
        <button
          type="button"
          className="editor-split-btn"
          title="Split right with the terminal"
          aria-label="Split right with the terminal"
          onClick={() => splitEditorWithTerminal('row', active.id)}
        >
          <IconSplit size={13} />
        </button>
        <button
          type="button"
          className="editor-split-btn split-down"
          title="Split down with the terminal"
          aria-label="Split down with the terminal"
          onClick={() => splitEditorWithTerminal('col', active.id)}
        >
          <IconSplit size={13} />
        </button>
        <button
          type="button"
          className="editor-split-btn"
          title={
            canSplitFile
              ? 'Split right with another open file'
              : 'Open another file to split two files'
          }
          aria-label="Split right with another open file"
          disabled={!canSplitFile}
          onClick={() => splitEditorWithFile('row', active.id)}
        >
          <IconSplit size={13} />
          <span className="editor-split-file">File</span>
        </button>
        <button
          type="button"
          className="editor-split-btn split-down"
          title={
            canSplitFile
              ? 'Split down with another open file'
              : 'Open another file to split two files'
          }
          aria-label="Split down with another open file"
          disabled={!canSplitFile}
          onClick={() => splitEditorWithFile('col', active.id)}
        >
          <IconSplit size={13} />
          <span className="editor-split-file">File</span>
        </button>
        {split && (
          <button
            type="button"
            className="editor-split-btn"
            title="Close the split and keep this file"
            aria-label="Close split"
            onClick={() => setSplit(null)}
          >
            Unsplit
          </button>
        )}
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
              title="Side-by-side preview (Ctrl/Cmd+Alt+M cycles modes)"
              onClick={() => setPreviewMode(active.id, previewMode === 'side' ? 'edit' : 'side')}
            >
              Side
            </button>
            <button
              type="button"
              className={`toggle ${previewMode === 'preview' ? 'active' : ''}`}
              aria-pressed={previewMode === 'preview'}
              title="Preview only (Ctrl/Cmd+Alt+M cycles modes)"
              onClick={() =>
                setPreviewMode(active.id, previewMode === 'preview' ? 'edit' : 'preview')
              }
            >
              Preview
            </button>
          </>
        )}
        <button
          className="ghost"
          disabled={active.state !== 'ready' || !activeSession || activeSession.kind === 'browser'}
          onClick={askAgent}
          title={
            activeSession && activeSession.kind !== 'browser'
              ? `Send the current selection to the ${activeSession.title} agent`
              : 'No terminal agent to send to'
          }
        >
          Ask agent
        </button>
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
            <CodeMirror key={active.id} doc={active} autoFocus={autoFocus} revealed={revealed} />
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

/** One CodeMirror instance bound to a single ready doc (remounts per doc via key). */
function CodeMirror({
  doc,
  autoFocus,
  revealed
}: {
  doc: EditorDoc
  autoFocus: boolean
  revealed: boolean
}) {
  const host = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<CMView | null>(null)
  const setContent = useEditors((s) => s.setContent)
  const save = useEditors((s) => s.save)

  // Stable callbacks for the CM extensions (which are built once on mount).
  const cb = useRef({ id: doc.id, setContent, save, autoFocus, revealed })
  cb.current = { id: doc.id, setContent, save, autoFocus, revealed }

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
      }),
      CMView.domEventHandlers({
        focus: () => {
          useEditors.getState().setActive(cb.current.id)
        }
      })
    ]
    const view = new CMView({
      state: EditorState.create({ doc: doc.content, extensions }),
      parent: host.current
    })
    viewRef.current = view
    registerEditorView(doc.id, view)
    const scroller = view.scrollDOM
    const saved = recallEditorScroll(doc.id)
    let ignoreScroll = saved != null
    const onScroll = () => {
      if (ignoreScroll || !cb.current.revealed) return
      rememberEditorScroll(
        doc.id,
        scroller.scrollTop,
        scroller.scrollLeft,
        scrollerLaidOut(scroller)
      )
    }
    scroller.addEventListener('scroll', onScroll, { passive: true })
    applyScroll(scroller, saved)
    if (cb.current.autoFocus) view.focus()
    applyScroll(scroller, saved)
    const restoreTimer = requestAnimationFrame(() => {
      applyScroll(scroller, saved)
      ignoreScroll = false
    })
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
      cancelAnimationFrame(restoreTimer)
      scroller.removeEventListener('scroll', onScroll)
      if (!ignoreScroll) {
        rememberEditorScroll(
          doc.id,
          scroller.scrollTop,
          scroller.scrollLeft,
          scrollerLaidOut(scroller)
        )
      }
      unregisterEditorView(doc.id)
      view.destroy()
      viewRef.current = null
    }
    // Built once per mounted doc; doc.content here is the loaded baseline.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return <div className="cm-host" ref={host} />
}
