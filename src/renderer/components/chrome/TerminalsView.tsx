import { lazy, Suspense, useMemo, useState, type Dispatch, type SetStateAction } from 'react'
import TerminalLayout from '../terminal/TerminalLayout'
import GroupBar from './GroupBar'
import ConfirmDialog from '../common/ConfirmDialog'
import {
  IconTerminals,
  IconLocal,
  IconRemote,
  IconAgent,
  IconEdit,
  IconPlus,
  IconGrid,
  IconClose,
  EmptyTerminalArt
} from '../common/Icons'
import { DEFAULT_GROUP, useLayout, type Group } from '../../store/layout'
import type { Session } from '../../store/sessions'
import type { EditorDoc } from '../../store/editors'
import { useSettings } from '../../store/settings'
import { setAgentUiMode } from '../../lib/agent-ui'
import { comboLabel, resolveHotkeys, type HotkeyId } from '../../lib/hotkeys'

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
  /** Open the Connections library so the SSH step has somewhere to go. */
  onOpenConnections?: () => void
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
  onOpenConnections,
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
  const welcomeHintSeen = useSettings((s) => s.welcomeHintSeen)
  const setWelcomeHintSeen = useSettings((s) => s.setWelcomeHintSeen)
  const firstRun = useSettings((s) => s.firstRun)
  const agentKind = useSettings((s) => s.agentKind)
  const keybindings = useSettings((s) => s.keybindings)
  const focusedId = useLayout((s) => s.focusedId)
  const effectiveShowGroupBar = showGroupBar && !zenMode
  const welcomeKeys = useMemo(() => {
    const hs = resolveHotkeys(keybindings)
    const label = (id: HotkeyId) => {
      const h = hs.find((x) => x.id === id)
      return h ? comboLabel(h, false) : ''
    }
    return {
      palette: label('palette'),
      newTerminal: label('newTerminal'),
      settings: label('settings')
    }
  }, [keybindings])
  const openWelcomeAgent = () => {
    const inGroup = (s: Session) =>
      (s.groupId || DEFAULT_GROUP) === activeGroupId && !s.closed && s.kind !== 'browser'
    const candidates = sessionsRef.filter(inGroup)
    const session =
      candidates.find((s) => s.id === focusedId) ??
      candidates.find((s) => s.kind === 'local') ??
      candidates[0]
    if (!session || (session.kind === 'remote' && !session.context)) return
    void setAgentUiMode(session.id, 'docked', {
      kind: session.agentKind ?? agentKind,
      title: session.context?.hostname ?? session.title
    })
  }
  const welcomeSteps = [
    {
      id: 'local',
      done: firstRun.localTerminal,
      title: 'Local terminal',
      copy: 'A shell in this group, ready to type.',
      action: 'Open',
      icon: IconLocal,
      onClick: onNewTerminalInGroup ?? onNewTerminal
    },
    {
      id: 'ssh',
      done: firstRun.importedSsh,
      title: 'SSH connection',
      copy: 'Import SSH config or save a host.',
      action: 'Add',
      icon: IconRemote,
      onClick: onOpenConnections
    },
    {
      id: 'agent',
      done: firstRun.openedAgent,
      title: 'DevTerm Agent',
      copy: 'Runs on this PC and works over SSH.',
      action: 'Start',
      icon: IconAgent,
      onClick: openWelcomeAgent
    }
  ]
  const welcomeOpen = welcomeSteps.some((step) => !step.done)
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
      {!welcomeHintSeen && !zenMode && sessionCount > 0 && welcomeOpen && (
        <section className="welcome-hint" aria-label="Getting started">
          <div className="welcome-hint-head">
            <span className="welcome-hint-title">Getting started</span>
            <div className="welcome-hint-keys">
              {welcomeKeys.palette && (
                <span>
                  <kbd>{welcomeKeys.palette}</kbd> palette
                </span>
              )}
              {welcomeKeys.newTerminal && (
                <span>
                  <kbd>{welcomeKeys.newTerminal}</kbd> new terminal
                </span>
              )}
              {welcomeKeys.settings && (
                <span>
                  <kbd>{welcomeKeys.settings}</kbd> settings
                </span>
              )}
            </div>
            <button
              type="button"
              className="welcome-hint-close"
              onClick={() => setWelcomeHintSeen(true)}
            >
              <IconClose size={12} />
              Dismiss
            </button>
          </div>
          <div className="welcome-cards">
            {welcomeSteps.map((step) => {
              const Icon = step.icon
              return (
                <button
                  key={step.id}
                  type="button"
                  className={`welcome-card${step.done ? ' is-done' : ''}`}
                  disabled={step.done || !step.onClick}
                  onClick={step.onClick}
                >
                  <span className="welcome-card-icon">
                    <Icon size={15} />
                  </span>
                  <span className="welcome-card-body">
                    <span className="welcome-card-title">{step.title}</span>
                    <span className="welcome-card-copy">{step.copy}</span>
                  </span>
                  <span className="welcome-card-state">{step.done ? 'Done' : step.action}</span>
                </button>
              )
            })}
          </div>
        </section>
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
              <div className="empty-title">Empty group</div>
              <div className="empty-sub">
                Open a terminal here, or drag a tab onto this group in the bar above.
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
              <div className="empty-sub">
                Open a local shell, connect to a server, or start a grid.
              </div>
              <button className="empty-cta" onClick={onNewTerminal}>
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
