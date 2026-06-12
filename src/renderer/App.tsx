import { useEffect, useMemo, useState } from 'react'
import TerminalLayout from './components/TerminalLayout'
import ConnectionForm from './components/ConnectionForm'
import FileExplorer from './components/FileExplorer'
import ConfirmActionModal from './components/ConfirmActionModal'
import EditorView from './components/EditorView'
import Splitter from './components/Splitter'
import NewTerminalModal from './components/NewTerminalModal'
import ConnectionsManager from './components/ConnectionsManager'
import WorkspacesManager from './components/WorkspacesManager'
import SnippetsManager from './components/SnippetsManager'
import CommandPalette from './components/CommandPalette'
import ShortcutsModal from './components/ShortcutsModal'
import SaveWorkspaceModal from './components/SaveWorkspaceModal'
import SettingsModal from './components/SettingsModal'
import { useSessions } from './store/sessions'
import { useEditors } from './store/editors'
import { useLayout, DEFAULT_GROUP, groupActiveSession, allLeaves } from './store/layout'
import { useSettings } from './store/settings'
import { matchHotkey } from './lib/hotkeys'
import { focusTerminal, clearTerminal } from './lib/terms'
import { capturableSessions, captureWorkspace } from './lib/workspace'
import {
  LogoMark,
  IconMenu,
  IconSettings,
  IconKeyboard,
  IconTerminals,
  IconGroup,
  IconSave,
  IconClose,
  IconPlus,
  IconLocal,
  IconRemote,
  IconBrowser,
  IconEdit,
  EmptyTerminalArt
} from './components/Icons'
import type { HostContext } from '@shared/types'

function osLabel(os?: string): string {
  switch (os) {
    case 'windows':
      return 'Windows'
    case 'linux':
      return 'Linux'
    case 'mac':
      return 'macOS'
    default:
      return 'unknown'
  }
}

function ContextBadge({ ctx }: { ctx?: HostContext }) {
  if (!ctx) return <span className="ctx ctx-pending">connecting…</span>
  return (
    <span className={`ctx ctx-${ctx.kind}`} title={ctx.detail}>
      {ctx.kind === 'local' ? <IconLocal size={12} /> : <IconRemote size={12} />}
      {ctx.kind === 'local' ? 'Local' : 'Remote'} · {osLabel(ctx.os)}
    </span>
  )
}

export default function App() {
  const { sessions, activeId, addLocal, addBrowser } = useSessions()
  const closeSession = useSessions((s) => s.close)
  const setSessionActive = useSessions((s) => s.setActive)
  const groups = useLayout((s) => s.groups)
  const activeGroupId = useLayout((s) => s.activeGroupId)
  const setActiveGroup = useLayout((s) => s.setActiveGroup)
  const createGroup = useLayout((s) => s.createGroup)
  const editorDocs = useEditors((s) => s.docs)
  const editorActiveId = useEditors((s) => s.activeId)
  const editorFocused = useEditors((s) => s.focused)
  const editorSetActive = useEditors((s) => s.setActive)
  const editorClose = useEditors((s) => s.close)
  const editorBlur = useEditors((s) => s.blur)
  const syncLayout = useLayout((s) => s.sync)
  const [showConnect, setShowConnect] = useState(false)
  const [showPicker, setShowPicker] = useState(false)
  const [showSaveWs, setShowSaveWs] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showPalette, setShowPalette] = useState(false)
  const [showShortcuts, setShowShortcuts] = useState(false)
  const [view, setView] = useState<'terminals' | 'connections' | 'workspaces' | 'snippets'>(
    'terminals'
  )
  // Group tab (or the "+" zone) currently hovered by a dragged terminal tab.
  const [dragOverGroup, setDragOverGroup] = useState<string | null>(null)
  const [showSidebar, setShowSidebar] = useState(true)
  const [sidebarWidth, setSidebarWidth] = useState(280)
  const [local, setLocal] = useState<HostContext | null>(null)
  const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))

  useEffect(() => {
    window.devterm.localContext().then(setLocal)
    if (sessions.length === 0) addLocal()
    // Push the saved auto-reconnect policy into the main process once on
    // boot so the SSH manager's loop matches what the user has configured.
    // (The settings store also pushes on every change; this is the initial
    // sync so the main process doesn't run with its built-in default until
    // the user touches the toggle.)
    window.devterm.ssh
      .setReconnectPolicy(useSettings.getState().autoReconnect)
      .catch(() => undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Move active terminal +1/-1 within the active group (wraps), and focus it.
  const cycleTerminal = (dir: 1 | -1) => {
    const { groups, activeGroupId, setActiveTab } = useLayout.getState()
    const g = groups.find((x) => x.id === activeGroupId)
    if (!g || !g.root) return
    const leaves = allLeaves(g.root)
    const order = leaves.flatMap((l) => l.tabs)
    if (order.length < 2) return
    const cur = groupActiveSession(g)
    const idx = cur ? order.indexOf(cur) : -1
    const next = order[(idx + dir + order.length) % order.length]
    const leaf = leaves.find((l) => l.tabs.includes(next))
    if (leaf) setActiveTab(leaf.id, next)
    useSessions.getState().setActive(next)
    focusTerminal(next)
  }

  // Bump the (shared) terminal font size, clamped to a sane range.
  const zoomFont = (delta: number) => {
    const cur = useSettings.getState().prefs.fontSize
    useSettings.getState().setPrefs({ fontSize: clamp(cur + delta, 8, 32) })
  }

  // Open another terminal like the active one: same cwd, and same saved
  // connection for remotes (ad-hoc remotes have no stored creds, so skip).
  const duplicateActive = async () => {
    const { sessions: list, activeId, addLocal, connectSsh } = useSessions.getState()
    const s = list.find((x) => x.id === activeId)
    if (!s) return
    if (s.kind === 'local') {
      addLocal({ cwd: s.cwd, groupId: s.groupId })
    } else if (s.kind === 'remote' && s.connectionId) {
      const conns = await window.devterm.connections.list()
      const c = conns.find((x) => x.id === s.connectionId)
      if (!c) return
      const { id: _id, name: _name, ...profile } = c
      connectSsh(profile, { connectionId: c.id, startCwd: s.cwd, groupId: s.groupId })
    }
  }

  // Global application hotkeys (see lib/hotkeys.ts). Reads live store state so it
  // can keep an empty dependency list. Matched terminal keys are blocked from the
  // shell by TerminalView's custom key handler.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Escape leaves focus (magnify) mode before any hotkey matching.
      if (e.key === 'Escape' && useLayout.getState().focusedId) {
        e.preventDefault()
        useLayout.getState().setFocus(null)
        return
      }
      const id = matchHotkey(e)
      if (!id) return
      e.preventDefault()
      switch (id) {
        case 'palette':
        case 'paletteAlt':
          setShowPalette((v) => !v)
          break
        case 'newTerminal':
          setView('terminals')
          setShowPicker(true)
          break
        case 'closeTerminal': {
          const activeId = useSessions.getState().activeId
          if (activeId) closeSession(activeId)
          break
        }
        case 'duplicateTerminal':
          void duplicateActive()
          break
        case 'toggleSidebar':
          setShowSidebar((v) => !v)
          break
        case 'clearTerminal': {
          const activeId = useSessions.getState().activeId
          if (activeId) clearTerminal(activeId)
          break
        }
        case 'zoomIn':
        case 'zoomInAlt':
          zoomFont(1)
          break
        case 'zoomOut':
          zoomFont(-1)
          break
        case 'zoomReset':
          useSettings.getState().setPrefs({ fontSize: 14 })
          break
        case 'find':
          // Handled per-terminal in TerminalView's key handler.
          break
        case 'settings':
          setShowSettings((v) => !v)
          break
        case 'nextTerminal':
          cycleTerminal(1)
          break
        case 'prevTerminal':
          cycleTerminal(-1)
          break
        case 'toggleFocus': {
          const fid = useSessions.getState().activeId
          useLayout.getState().toggleFocus(fid)
          if (fid) focusTerminal(fid)
          break
        }
        case 'shortcuts':
          setShowShortcuts((v) => !v)
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Keep the per-group tiling layout reconciled with the live session list.
  const sessionKey = useMemo(
    () => sessions.map((s) => `${s.id}@${s.groupId || DEFAULT_GROUP}`).join(','),
    [sessions]
  )
  useEffect(() => {
    syncLayout(sessions.map((s) => ({ id: s.id, groupId: s.groupId })))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionKey])

  const active = sessions.find((s) => s.id === activeId) || null

  // Switch the visible terminal group, focusing its active terminal.
  const switchGroup = (gid: string) => {
    setActiveGroup(gid)
    const sid = groupActiveSession(groups.find((g) => g.id === gid))
    if (sid) setSessionActive(sid)
  }
  // Close a whole group: close every terminal in it.
  const closeGroup = (gid: string) => {
    sessions.filter((s) => (s.groupId || DEFAULT_GROUP) === gid).forEach((s) => closeSession(s.id))
  }
  const groupCount = (gid: string) =>
    sessions.filter((s) => (s.groupId || DEFAULT_GROUP) === gid).length

  // Drag-drop a terminal tab onto a group tab: move that session into the group
  // (the layout sync reconciles the trees) and follow it there.
  const moveToGroup = (sid: string, gid: string) => {
    if (!sid || !sessions.some((s) => s.id === sid)) return
    useSessions.getState().setGroup(sid, gid)
    setActiveGroup(gid)
  }
  // Drag-drop onto the "+" zone: spin the dragged terminal off into a brand-new group.
  const spinOffGroup = (sid: string) => {
    if (!sid || !sessions.some((s) => s.id === sid)) return
    const gid = createGroup()
    useSessions.getState().setGroup(sid, gid)
  }
  // Show every group, including an empty default "Terminals" tab: it's the home
  // for ungrouped terminals, so it must stay reachable even when empty (otherwise
  // dragging your last loose terminal into a group leaves no way back to make a
  // new ungrouped one). An empty active group shows the "Empty group" prompt.
  const visibleGroups = groups
  // Terminals the active group can be saved as a workspace from.
  const capturable = capturableSessions(sessions, activeGroupId)
  // A freshly created group has no terminals yet — show a prompt to add one.
  const activeGroupCount = groupCount(activeGroupId)
  // The group bar now also hosts the "Save as workspace" action, so show it
  // whenever terminals are open (not just when there's more than one group).
  const showGroupBar = !editorFocused && sessions.length > 0

  const saveWorkspace = async (name: string) => {
    const { items, layout } = captureWorkspace(sessions, activeGroupId)
    if (!items.length) return
    await window.devterm.workspaces.save({ id: '', name, items, layout })
    setShowSaveWs(false)
  }

  return (
    <div className="app">
      <div className="titlebar">
        <button
          className="sidebar-toggle"
          title="Toggle file explorer"
          onClick={() => setShowSidebar((v) => !v)}
        >
          <IconMenu size={17} />
        </button>
        <span className="brand">
          <LogoMark size={20} />
          <span className="brand-name">DevTerm</span>
        </span>
        <span className="badge">{local ? `${local.hostname} · ${osLabel(local.os)}` : ''}</span>
        <nav className="top-nav">
          <button
            className={view === 'terminals' ? 'active' : ''}
            onClick={() => setView('terminals')}
          >
            Terminals
          </button>
          <button
            className={view === 'connections' ? 'active' : ''}
            onClick={() => setView('connections')}
          >
            Connections
          </button>
          <button
            className={view === 'workspaces' ? 'active' : ''}
            onClick={() => setView('workspaces')}
          >
            Workspaces
          </button>
          <button
            className={view === 'snippets' ? 'active' : ''}
            onClick={() => setView('snippets')}
          >
            Snippets
          </button>
        </nav>
        <span className="spacer" />
        <button
          className="settings-btn"
          title="Keyboard shortcuts (Ctrl/Cmd+/)"
          onClick={() => setShowShortcuts(true)}
        >
          <IconKeyboard size={17} />
        </button>
        <button className="settings-btn" title="Settings" onClick={() => setShowSettings(true)}>
          <IconSettings size={17} />
        </button>
      </div>

      <div className="body">
        {showSidebar && (
          <>
            <aside className="sidebar" style={{ width: sidebarWidth }}>
              <FileExplorer />
            </aside>
            <Splitter
              direction="horizontal"
              onDelta={(d) => setSidebarWidth((w) => clamp(w + d, 180, 600))}
            />
          </>
        )}

        <div className="main">
          {view === 'terminals' && editorDocs.length > 0 && (
            <div className="tabs">
              <div
                className={`tab ${!editorFocused ? 'active' : ''}`}
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
                    title={d.path}
                    onClick={() => editorSetActive(d.id)}
                  >
                    <span className="tab-icon">
                      {d.scope === 'remote' ? <IconRemote size={13} /> : <IconEdit size={13} />}
                    </span>
                    <span className="tab-title">{d.name}</span>
                    <span
                      className="tab-close"
                      onClick={(e) => {
                        e.stopPropagation()
                        editorClose(d.id)
                      }}
                    >
                      {dirty ? '●' : '×'}
                    </span>
                  </div>
                )
              })}
            </div>
          )}

          <div className="panes-area">
            {/*
              The terminals view stays mounted at all times — switching to
              Connections/Workspaces only hides it. Unmounting it would tear
              down every TerminalView, killing the local PTYs and dropping the
              SSH shells. Other views overlay on top when active. Hidden with
              `visibility` (not display:none) so the terminals keep their real
              dimensions and stay fitted while another view is shown — a
              display-hidden terminal is 0×0 and can't refit until reveal,
              which corrupted/clipped its output.
            */}
            <div
              className="view-pane"
              style={{ visibility: view === 'terminals' ? undefined : 'hidden' }}
            >
              <div className="terminals-stack">
                {showGroupBar && (
                  <div className="group-bar">
                    {visibleGroups.map((g) => (
                      <div
                        key={g.id}
                        className={`group-tab ${g.id === activeGroupId ? 'active' : ''} ${
                          dragOverGroup === g.id ? 'drop-target' : ''
                        }`}
                        onClick={() => switchGroup(g.id)}
                        title={
                          g.id === DEFAULT_GROUP
                            ? 'Ungrouped terminals — drag a tab here to move it in'
                            : `Group: ${g.name} — drag a tab here to move it in`
                        }
                        onDragOver={(e) => {
                          e.preventDefault()
                          e.dataTransfer.dropEffect = 'move'
                          if (dragOverGroup !== g.id) setDragOverGroup(g.id)
                        }}
                        onDragLeave={() => setDragOverGroup((v) => (v === g.id ? null : v))}
                        onDrop={(e) => {
                          e.preventDefault()
                          moveToGroup(e.dataTransfer.getData('text/plain'), g.id)
                          setDragOverGroup(null)
                        }}
                      >
                        <span className="group-icon">
                          {g.id === DEFAULT_GROUP ? (
                            <IconTerminals size={14} />
                          ) : (
                            <IconGroup size={14} />
                          )}
                        </span>
                        <span className="group-name">{g.name}</span>
                        <span className="group-count">{groupCount(g.id)}</span>
                        {g.id !== DEFAULT_GROUP && (
                          <span
                            className="group-close"
                            title="Close group (closes its terminals)"
                            onClick={(e) => {
                              e.stopPropagation()
                              closeGroup(g.id)
                            }}
                          >
                            <IconClose size={12} />
                          </span>
                        )}
                      </div>
                    ))}
                    <div
                      className={`group-new ${dragOverGroup === '__new__' ? 'drop-target' : ''}`}
                      title="New group with a local terminal (or drop a terminal here to group it)"
                      onClick={() => {
                        const gid = createGroup()
                        addLocal({ groupId: gid })
                      }}
                      onDragOver={(e) => {
                        e.preventDefault()
                        e.dataTransfer.dropEffect = 'move'
                        if (dragOverGroup !== '__new__') setDragOverGroup('__new__')
                      }}
                      onDragLeave={() => setDragOverGroup((v) => (v === '__new__' ? null : v))}
                      onDrop={(e) => {
                        e.preventDefault()
                        spinOffGroup(e.dataTransfer.getData('text/plain'))
                        setDragOverGroup(null)
                      }}
                    >
                      <IconPlus size={14} />
                    </div>
                    <span className="spacer" />
                    <button
                      className="group-save"
                      title="Save this group's terminals as a workspace"
                      disabled={capturable.length === 0}
                      onClick={() => setShowSaveWs(true)}
                    >
                      <IconSave size={14} />
                      <span>Save group</span>
                    </button>
                  </div>
                )}
                <div className="terminals-body">
                  <div
                    className="layout-wrap"
                    style={{
                      // visibility (not display) — keep hidden terminals sized; see view-pane above.
                      visibility: editorFocused || sessions.length === 0 ? 'hidden' : undefined
                    }}
                  >
                    <TerminalLayout sessions={sessions} onNewTerminal={() => setShowPicker(true)} />
                  </div>
                  {/*
                    The active tab has no terminals but others live in other groups —
                    the layout above renders blank (its tree is null), so overlay a
                    prompt. Opening here targets the active group explicitly so the new
                    terminal always lands in the tab you're looking at. TerminalLayout
                    stays mounted regardless so other groups' PTYs live.
                  */}
                  {!editorFocused && sessions.length > 0 && activeGroupCount === 0 && (
                    <div className="empty empty-group-overlay">
                      <div className="empty-card">
                        <EmptyTerminalArt />
                        <div className="empty-title">
                          {activeGroupId === DEFAULT_GROUP
                            ? 'No ungrouped terminals'
                            : 'Empty group'}
                        </div>
                        <div className="empty-sub">
                          {activeGroupId === DEFAULT_GROUP
                            ? 'Open a terminal here, or drag one out of a group to ungroup it.'
                            : 'Open a terminal here, or drag a tab onto this group in the bar above.'}
                        </div>
                        <button
                          className="empty-cta"
                          onClick={() => addLocal({ groupId: activeGroupId })}
                        >
                          <IconPlus size={15} />
                          New terminal
                        </button>
                      </div>
                    </div>
                  )}
                  {editorFocused && editorActiveId && (
                    <div className="pane pane-editor">
                      <EditorView />
                    </div>
                  )}
                  {sessions.length === 0 && !editorFocused && (
                    <div className="empty">
                      <div className="empty-card">
                        <EmptyTerminalArt />
                        <div className="empty-title">No terminals open</div>
                        <div className="empty-sub">Open a local shell or connect to a server.</div>
                        <button className="empty-cta" onClick={() => setShowPicker(true)}>
                          <IconPlus size={15} />
                          New terminal
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
            {view === 'connections' && (
              <div className="view-pane">
                <ConnectionsManager onConnect={() => setView('terminals')} />
              </div>
            )}
            {view === 'workspaces' && (
              <div className="view-pane">
                <WorkspacesManager onLaunch={() => setView('terminals')} />
              </div>
            )}
            {view === 'snippets' && (
              <div className="view-pane">
                <SnippetsManager onRun={() => setView('terminals')} />
              </div>
            )}
          </div>

          <div className="statusbar">
            {active ? (
              active.kind === 'browser' ? (
                // Browser tabs have no shell/SSH context, so the ContextBadge would
                // sit forever on its "connecting…" placeholder. Show a browser badge
                // plus the live page title instead.
                <>
                  <span className="ctx ctx-browser">
                    <IconBrowser size={12} />
                    Browser
                  </span>
                  <span className="status-msg">
                    {active.title && active.title !== 'Browser' ? active.title : 'open'}
                  </span>
                </>
              ) : (
                <>
                  <ContextBadge ctx={active.context} />
                  <span className="status-msg">{active.status || ''}</span>
                </>
              )
            ) : (
              'ready'
            )}
          </div>
        </div>
      </div>

      {showPicker && (
        <NewTerminalModal
          onLocal={() => {
            setView('terminals')
            addLocal()
            setShowPicker(false)
          }}
          onRemote={() => {
            setView('terminals')
            setShowPicker(false)
            setShowConnect(true)
          }}
          onBrowser={() => {
            setView('terminals')
            addBrowser()
            setShowPicker(false)
          }}
          onClose={() => setShowPicker(false)}
        />
      )}
      {showSaveWs && (
        <SaveWorkspaceModal
          capturable={capturable}
          onSave={saveWorkspace}
          onClose={() => setShowSaveWs(false)}
        />
      )}
      {showConnect && <ConnectionForm onClose={() => setShowConnect(false)} />}
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
      {showPalette && (
        <CommandPalette onRun={() => setView('terminals')} onClose={() => setShowPalette(false)} />
      )}
      {showShortcuts && <ShortcutsModal onClose={() => setShowShortcuts(false)} />}
      <ConfirmActionModal />
    </div>
  )
}
