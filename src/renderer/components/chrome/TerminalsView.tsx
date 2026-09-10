import { lazy, Suspense, useState, type Dispatch, type SetStateAction } from 'react'
import TerminalLayout from '../terminal/TerminalLayout'
import GroupBar from './GroupBar'
import ConfirmDialog from '../common/ConfirmDialog'
import {
  IconTerminals,
  IconRemote,
  IconEdit,
  IconPlus,
  IconGrid,
  EmptyTerminalArt
} from '../common/Icons'
import { DEFAULT_GROUP, type Group } from '../../store/layout'
import type { Session } from '../../store/sessions'
import type { EditorDoc } from '../../store/editors'
import { useSettings } from '../../store/settings'

// CodeMirror and its editor-only UI are unnecessary for the terminal-first
// screen. Keep them in a local async chunk and load only when a document is
// focused; terminals continue running underneath while it resolves.
const EditorView = lazy(() => import('../files/EditorView'))

interface TerminalsViewProps {
  showGroupBar: boolean
  groups: Group[]
  activeGroupId: string
  sessionsRef: Session[]
  sessionCount: number
  editorFocused: boolean
  editorActiveId: string | null
  editorDocs: EditorDoc[]
  editorBlur: () => void
  editorSetActive: (id: string) => void
  editorClose: (id: string) => void
  onNewTerminal: () => void
  onNewTerminalInGroup?: () => void
  onCreateGrid?: () => void
  onSaveWorkspace: () => void
  saveBackToWorkspace: () => void
  launchedFromId?: string
  capturable: Session[]
  // GroupBar wiring
  dragOverGroup?: string | null
  setDragOverGroup?: Dispatch<SetStateAction<string | null>>
  switchGroup?: (id: string) => void
  closeGroup?: (id: string) => void
  /** Guarded session close (confirmation lives in App). */
  onRequestCloseSession?: (sid: string) => void
  createGroupAndLocal?: () => void
  moveToGroup?: (sid: string, gid: string) => void
  spinOffGroup?: (sid: string) => void
}

export default function TerminalsView({
  showGroupBar,
  groups,
  activeGroupId,
  sessionsRef,
  sessionCount,
  editorFocused,
  editorActiveId,
  editorDocs,
  editorBlur,
  editorSetActive,
  editorClose,
  onNewTerminal,
  onNewTerminalInGroup,
  onCreateGrid,
  onSaveWorkspace,
  saveBackToWorkspace,
  launchedFromId,
  capturable,
  dragOverGroup = null,
  setDragOverGroup = (_value) => undefined,
  switchGroup = () => {},
  closeGroup = () => {},
  onRequestCloseSession,
  createGroupAndLocal = () => {},
  moveToGroup = () => {},
  spinOffGroup = () => {}
}: TerminalsViewProps) {
  const activeGroupCount = sessionsRef.filter(
    (s) => (s.groupId || DEFAULT_GROUP) === activeGroupId
  ).length
  const zenMode = useSettings((s) => s.zenMode)
  const effectiveShowGroupBar = showGroupBar && !zenMode
  // Dirty editor close confirmation (a single doc, so one pending id is enough).
  const [pendingEditorClose, setPendingEditorClose] = useState<string | null>(null)
  const requestEditorClose = (id: string, dirty: boolean) => {
    if (dirty) setPendingEditorClose(id)
    else editorClose(id)
  }

  // Editor tabs must live *inside* `.terminals-stack` (flex column). The stack
  // is `position: absolute; inset: 0` over the whole view-pane, so a sibling
  // tab strip above it was fully covered and users could not leave the editor.
  return (
    <div className="terminals-stack">
      {editorDocs.length > 0 && (
        <div className="tabs editor-tabs" role="tablist" aria-label="Editor documents">
          <div
            className={`tab ${!editorFocused ? 'active' : ''}`}
            role="tab"
            aria-selected={!editorFocused}
            onClick={editorBlur}
            title="Back to terminals"
          >
            <span className="tab-icon">
              <IconTerminals size={13} />
            </span>
            <span className="tab-title">Terminals</span>
          </div>
          {editorDocs.map((d) => {
            const dirty = d.state === 'ready' && d.content !== d.savedContent
            return (
              <div
                key={d.id}
                className={`tab tab-editor ${d.id === editorActiveId && editorFocused ? 'active' : ''}`}
                role="tab"
                aria-selected={d.id === editorActiveId && editorFocused}
                title={d.path}
                onClick={() => editorSetActive(d.id)}
              >
                <span className="tab-icon">
                  {d.scope === 'remote' ? <IconRemote size={13} /> : <IconEdit size={13} />}
                </span>
                <span className="tab-title">{d.name}</span>
                <button
                  type="button"
                  className="tab-close"
                  aria-label={dirty ? `Close ${d.name} (unsaved)` : `Close ${d.name}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    requestEditorClose(d.id, dirty)
                  }}
                >
                  {dirty ? '●' : '×'}
                </button>
              </div>
            )
          })}
        </div>
      )}

      {effectiveShowGroupBar && (
        <GroupBar
          groups={groups}
          activeGroupId={activeGroupId}
          sessionsRef={sessionsRef}
          dragOverGroup={dragOverGroup}
          setDragOverGroup={setDragOverGroup}
          switchGroup={switchGroup}
          closeGroup={closeGroup}
          createGroupAndLocal={createGroupAndLocal}
          moveToGroup={moveToGroup}
          spinOffGroup={spinOffGroup}
          launchedFromId={launchedFromId}
          capturable={capturable}
          onSaveNew={onSaveWorkspace}
          onSaveBack={saveBackToWorkspace}
        />
      )}
      <div className="terminals-body">
        <div className={`layout-wrap${editorFocused || sessionCount === 0 ? ' term-hidden' : ''}`}>
          <TerminalLayout
            sessions={sessionsRef}
            onNewTerminal={onNewTerminal}
            onRequestCloseSession={onRequestCloseSession}
          />
        </div>

        {!editorFocused && sessionCount > 0 && activeGroupCount === 0 && (
          <div className="empty empty-group-overlay">
            <div className="empty-card">
              <EmptyTerminalArt />
              <div className="empty-title">
                {activeGroupId === DEFAULT_GROUP ? 'No ungrouped terminals' : 'Empty group'}
              </div>
              <div className="empty-sub">
                {activeGroupId === DEFAULT_GROUP
                  ? 'Open a terminal here, or drag one out of a group to ungroup it.'
                  : 'Open a terminal here, or drag a tab onto this group in the bar above.'}
              </div>
              <button className="empty-cta" onClick={onNewTerminalInGroup ?? onNewTerminal}>
                <IconPlus size={15} />
                New terminal
              </button>
              <button className="empty-cta secondary" onClick={onCreateGrid ?? onNewTerminal}>
                <IconGrid size={15} />
                Create grid…
              </button>
            </div>
          </div>
        )}

        {editorFocused && editorActiveId && (
          <div className="pane pane-editor">
            <Suspense fallback={<div className="editor-status">Opening editor…</div>}>
              <EditorView />
            </Suspense>
          </div>
        )}

        {sessionCount === 0 && !editorFocused && (
          <div className="empty">
            <div className="empty-card">
              <EmptyTerminalArt />
              <div className="empty-title">No terminals open</div>
              <div className="empty-sub">Open a local shell, connect to a server, or start a grid.</div>
              <button className="empty-cta" onClick={onNewTerminal}>
                <IconPlus size={15} />
                New terminal
              </button>
              <button
                className="empty-cta secondary"
                onClick={onCreateGrid ?? onNewTerminal}
              >
                <IconGrid size={15} />
                Create grid…
              </button>
            </div>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={pendingEditorClose !== null}
        title="Discard unsaved changes?"
        message="This file has unsaved changes. Closing the tab discards them."
        confirmLabel="Discard & close"
        onConfirm={() => {
          if (pendingEditorClose) editorClose(pendingEditorClose)
          setPendingEditorClose(null)
        }}
        onClose={() => setPendingEditorClose(null)}
      />
    </div>
  )
}
