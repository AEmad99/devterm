import { useEffect, useMemo, useRef, useState } from 'react'
import ConnectionForm from './components/connections/ConnectionForm'
import FileExplorer from './components/files/FileExplorer'
import ConfirmActionModal from './components/modals/ConfirmActionModal'
import Splitter from './components/common/Splitter'
import NewTerminalModal from './components/terminal/NewTerminalModal'
import CreateGridModal from './components/terminal/CreateGridModal'
import ConnectionsManager from './components/connections/ConnectionsManager'
import WorkspacesManager from './components/workspaces/WorkspacesManager'
import SnippetsManager from './components/snippets/SnippetsManager'
import CommandPalette from './components/modals/CommandPalette'
import ShortcutsModal from './components/modals/ShortcutsModal'
import { GlobalSearchModal } from './components/modals/GlobalSearchModal'
import SaveWorkspaceModal from './components/workspaces/SaveWorkspaceModal'
import SettingsModal from './components/modals/SettingsModal'
import AppToolbar from './components/chrome/AppToolbar'
import TerminalsView from './components/chrome/TerminalsView'
import StatusBar from './components/chrome/StatusBar'
import TransfersPanel from './components/transfers/TransfersPanel'
import { useTransfersSync } from './lib/useTransfersSync'
import { useSessions } from './store/sessions'
import { useEditors } from './store/editors'
import { useLayout, DEFAULT_GROUP, groupActiveSession, allLeaves } from './store/layout'
import { useSettings } from './store/settings'
import { matchHotkey, resolveHotkeys, comboLabel, HOTKEYS, type HotkeyId } from './lib/hotkeys'
import { focusTerminal, clearTerminal, openTerminalFind, openTmuxPicker } from './lib/terms'
import { capturableSessions, captureWorkspace, launchWorkspaceIntoGroup } from './lib/workspace'
import { persistSessionRestore, restoreSessionSnapshot } from './lib/session-restore'
import { dictation } from './lib/stt/dictation'
import { useDictation } from './store/dictation'
import DictationStatus from './components/dictation/DictationStatus'
import GitPanel from './components/git/GitPanel'
import { initBrowserControl } from './lib/browser-control'
import { initAgentHandoff } from './lib/agent-handoff'
import type { HostContext } from '@shared/types'
import type { View, BottomPanelMode } from './components/chrome/types'

export default function App() {
  // Cluster B: narrow selectors so App only re-renders when its own slices move.
  const sessionCount = useSessions((s) => s.sessions.length)
  const sessionsRef = useSessions((s) => s.sessions)
  const addLocal = useSessions((s) => s.addLocal)
  const addBrowser = useSessions((s) => s.addBrowser)
  const closeSession = useSessions((s) => s.close)
  const setSessionActive = useSessions((s) => s.setActive)
  const groups = useLayout((s) => s.groups)
  const activeGroupId = useLayout((s) => s.activeGroupId)
  const setActiveGroup = useLayout((s) => s.setActiveGroup)
  const createGroup = useLayout((s) => s.createGroup)
  const groupFlags = useLayout((s) => s.groupFlags)
  const editorDocs = useEditors((s) => s.docs)
  const editorActiveId = useEditors((s) => s.activeId)
  const editorFocused = useEditors((s) => s.focused)
  const editorSetActive = useEditors((s) => s.setActive)
  const editorClose = useEditors((s) => s.close)
  const editorBlur = useEditors((s) => s.blur)
  const syncLayout = useLayout((s) => s.sync)

  useTransfersSync()
  // Agent browser control: route main's browser_open requests into panes.
  useEffect(() => initBrowserControl(), [])
  // Local-agent handoff: turn main's request into a visible sibling tab.
  useEffect(() => initAgentHandoff(), [])
  const transfersPanelOpen = useSettings((s) => s.transfersPanelOpen)
  const setTransfersPanelOpen = useSettings((s) => s.setTransfersPanelOpen)
  const agentActivityCollapsed = useSettings((s) => s.agentActivityCollapsed)
  const setAgentActivityCollapsed = useSettings((s) => s.setAgentActivityCollapsed)
  const zenMode = useSettings((s) => s.zenMode)
  const gitPanelOpen = useSettings((s) => s.gitPanelOpen)
  const setGitPanelOpen = useSettings((s) => s.setGitPanelOpen)
  const welcomeHintSeen = useSettings((s) => s.welcomeHintSeen)
  const setWelcomeHintSeen = useSettings((s) => s.setWelcomeHintSeen)
  const keybindings = useSettings((s) => s.keybindings)

  const bottomPanelMode: BottomPanelMode = transfersPanelOpen
    ? 'transfers'
    : agentActivityCollapsed
      ? 'off'
      : 'activity'
  const setBottomPanelMode = (mode: BottomPanelMode) => {
    if (mode === 'transfers') {
      setTransfersPanelOpen(true)
      setAgentActivityCollapsed(true)
    } else if (mode === 'activity') {
      setTransfersPanelOpen(false)
      setAgentActivityCollapsed(false)
    } else {
      setTransfersPanelOpen(false)
      setAgentActivityCollapsed(true)
    }
  }

  const [showConnect, setShowConnect] = useState(false)
  const [showPicker, setShowPicker] = useState(false)
  const [showGrid, setShowGrid] = useState(false)
  const [showSaveWs, setShowSaveWs] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showPalette, setShowPalette] = useState(false)
  const [showShortcuts, setShowShortcuts] = useState(false)
  const [view, setView] = useState<View>('terminals')
  const [dragOverGroup, setDragOverGroup] = useState<string | null>(null)
  const [showSidebar, setShowSidebar] = useState(true)
  const [sidebarWidth, setSidebarWidth] = useState(280)
  const [local, setLocal] = useState<HostContext | null>(null)
  const [globalSearchOpen, setGlobalSearchOpen] = useState(false)
  const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))

  useEffect(() => {
    window.devterm.localContext().then(setLocal)
    // Boot order:
    //  1) Workspaces with autoLaunch (operator-chosen presets win)
    //  2) Last-session restore (if enabled and a snapshot exists)
    //  3) Empty local shell so the window is never blank
    void (async () => {
      const wsList = await window.devterm.workspaces.list()
      const toAutoLaunch = wsList.filter((w) => w.autoLaunch)
      if (toAutoLaunch.length > 0) {
        const conns = await window.devterm.connections.list()
        for (const ws of toAutoLaunch) {
          // `recordLaunch: false` — auto-launching on app boot doesn't count
          // as an operator-initiated launch.
          await launchWorkspaceIntoGroup(ws, conns, { recordLaunch: false })
        }
        return
      }
      if (useSettings.getState().sessionRestore) {
        try {
          const snap = await window.devterm.sessionRestore.load()
          if (snap?.groups?.length) {
            const conns = await window.devterm.connections.list()
            const ok = await restoreSessionSnapshot(snap, conns)
            if (ok) return
          }
        } catch {
          /* fall through to empty local */
        }
      }
      if (useSessions.getState().sessions.length === 0) addLocal()
    })()
    window.devterm.ssh
      .setReconnectPolicy(useSettings.getState().autoReconnect)
      .catch(() => undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Agent UI modes can change from a floating OS window; apply locally so the
  // main session store (docked/hidden/floating chrome) stays in sync.
  useEffect(() => {
    return window.devterm.agent.onUiModeChanged(({ sessionId, mode }) => {
      useSessions.getState().setAgentUi(sessionId, { mode }, { localOnly: true })
    })
  }, [])

  // Debounced last-session snapshot so a crash/quit can reopen the layout.
  useEffect(() => {
    if (!useSettings.getState().sessionRestore) return
    const t = window.setTimeout(() => {
      void persistSessionRestore()
    }, 1500)
    return () => clearTimeout(t)
  }, [sessionsRef, groups])

  // Flush restore snapshot on page hide / unload (best-effort).
  useEffect(() => {
    const flush = () => {
      if (useSettings.getState().sessionRestore) void persistSessionRestore()
    }
    window.addEventListener('pagehide', flush)
    return () => window.removeEventListener('pagehide', flush)
  }, [])

  useEffect(() => {
    const onFocus = () => {
      const { activeId, setNeedsAttention } = useSessions.getState()
      if (activeId) setNeedsAttention(activeId, false)
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])

  const cycleTab = (dir: 1 | -1) => {
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

  const cycleLeafTab = (dir: 1 | -1) => {
    const { groups, activeGroupId, setActiveTab } = useLayout.getState()
    const g = groups.find((x) => x.id === activeGroupId)
    if (!g || !g.root) return
    const cur = groupActiveSession(g)
    if (!cur) return
    const leaves = allLeaves(g.root)
    const leaf = leaves.find((l) => l.tabs.includes(cur))
    if (!leaf || leaf.tabs.length < 2) return
    const idx = leaf.tabs.indexOf(cur)
    const next = leaf.tabs[(idx + dir + leaf.tabs.length) % leaf.tabs.length]
    setActiveTab(leaf.id, next)
    useSessions.getState().setActive(next)
    focusTerminal(next)
  }

  const zoomFont = (delta: number) => {
    const cur = useSettings.getState().prefs.fontSize
    useSettings.getState().setPrefs({ fontSize: clamp(cur + delta, 8, 32) })
  }

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

  const isTerminalHostFocused = (): boolean => {
    if (typeof document === 'undefined') return false
    const el = document.activeElement as HTMLElement | null
    if (!el) return false
    return !!el.closest?.('.terminal-host')
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const keybindings = useSettings.getState().keybindings
      const id = matchHotkey(e, resolveHotkeys(keybindings))
      if (id) {
        if ((id === 'nextTab' || id === 'prevTab') && !isTerminalHostFocused()) {
          return
        }
        if (id === 'saveEditor') {
          const ed = useEditors.getState()
          const doc = ed.docs.find((d) => d.id === ed.activeId)
          if (!ed.focused || !doc || doc.state !== 'ready') return
          e.preventDefault()
          void ed.save(doc.id)
          return
        }
        // Don't hijack shortcuts when the user is typing in an input/editor.
        // Exception: xterm's helper textarea is not user text input — a
        // terminal holds focus ~100% of the time, and TerminalView's custom
        // key handler already keeps matched hotkeys from reaching the shell
        // as control bytes, so global hotkeys must still fire from it.
        const el = document.activeElement as HTMLElement | null
        const inXterm = el?.classList.contains('xterm-helper-textarea') ?? false
        if (
          !inXterm &&
          el &&
          (el.tagName === 'TEXTAREA' ||
            el.tagName === 'INPUT' ||
            el.isContentEditable ||
            el.closest?.('[contenteditable]') != null)
        ) {
          return
        }
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
          case 'newGrid':
            setView('terminals')
            setShowGrid(true)
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
          case 'find': {
            const activeId = useSessions.getState().activeId
            if (activeId) openTerminalFind(activeId)
            break
          }
          case 'settings':
            setShowSettings((v) => !v)
            break
          case 'nextTerminal':
            cycleTab(1)
            break
          case 'prevTerminal':
            cycleTab(-1)
            break
          case 'nextTab':
            if (isTerminalHostFocused()) cycleLeafTab(1)
            break
          case 'prevTab':
            if (isTerminalHostFocused()) cycleLeafTab(-1)
            break
          case 'toggleFocus': {
            const fid = useSessions.getState().activeId
            useLayout.getState().toggleFocus(fid)
            if (fid) focusTerminal(fid)
            break
          }
          case 'toggleZenMode': {
            const cur = useSettings.getState().zenMode
            useSettings.getState().setZenMode(!cur)
            break
          }
          case 'tmuxSessions': {
            const activeId = useSessions.getState().activeId
            if (activeId) openTmuxPicker(activeId)
            break
          }
          case 'shortcuts':
            setShowShortcuts((v) => !v)
            break
          case 'globalSearch':
            setGlobalSearchOpen((v) => !v)
            break
          // 'dictate' is owned by the push-to-talk useEffect below.
        }
        return
      }
      if (e.key === 'Escape') {
        if (useLayout.getState().focusedId) {
          e.preventDefault()
          useLayout.getState().setFocus(null)
          return
        }
        // No terminal is focus-magnified, but the editor may have stolen the
        // pane. Esc returns control to the terminals without forcing the user
        // to hunt for a back button.
        const ed = useEditors.getState()
        if (ed.focused) {
          e.preventDefault()
          ed.blur()
          return
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Push-to-talk dictation. Holds the dictate hotkey to record, releases to
  // transcribe. Runs as a separate effect so we can own the keyup/blur path
  // without disturbing the keydown switch above. A `pttActiveKey` ref guards
  // against spurious stops from a different key being released while the
  // dictate combo is still held.
  const pttActiveKey = useRef<string | null>(null)

  useEffect(() => {
    const matchesDictate = (
      e: KeyboardEvent,
      h: ReturnType<typeof resolveHotkeys>[number] | undefined
    ) => {
      if (!h) return false
      const mod = e.ctrlKey || e.metaKey
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key
      return (
        Boolean(h.mod) === mod &&
        Boolean(h.shift) === e.shiftKey &&
        Boolean(h.alt) === e.altKey &&
        h.key === key
      )
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (!useSettings.getState().stt.enabled) return
      if (e.repeat) return
      const hotkeys = resolveHotkeys(useSettings.getState().keybindings)
      const dictate = hotkeys.find((h) => h.id === 'dictate')
      if (!matchesDictate(e, dictate)) return
      const status = useDictation.getState().status
      if (status !== 'idle' && status !== 'error') return
      pttActiveKey.current = e.key.toLowerCase()
      void dictation.start()
    }

    const onKeyUp = (e: KeyboardEvent) => {
      if (!pttActiveKey.current) return
      if (e.key.toLowerCase() !== pttActiveKey.current) return
      pttActiveKey.current = null
      if (useDictation.getState().status === 'recording') {
        void dictation.stop()
      } else if (useDictation.getState().status === 'requesting-mic') {
        void dictation.cancel()
      }
    }

    const onBlur = () => {
      if (!pttActiveKey.current) return
      // Don't cancel mid-press; finalize so the audio isn't lost. The ref is
      // also cleared so a later (out-of-window) keyup doesn't double-stop.
      pttActiveKey.current = null
      if (useDictation.getState().status === 'recording') {
        void dictation.stop()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [])

  const sessionKey = useMemo(
    () => sessionsRef.map((s) => `${s.id}@${s.groupId || DEFAULT_GROUP}`).join(','),
    [sessionsRef]
  )
  useEffect(() => {
    syncLayout(sessionsRef.map((s) => ({ id: s.id, groupId: s.groupId })))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionKey])

  const switchGroup = (gid: string) => {
    setActiveGroup(gid)
    const sid = groupActiveSession(groups.find((g) => g.id === gid))
    if (sid) setSessionActive(sid)
  }
  const closeGroup = (gid: string) => {
    sessionsRef
      .filter((s) => (s.groupId || DEFAULT_GROUP) === gid)
      .forEach((s) => closeSession(s.id))
  }

  const moveToGroup = (sid: string, gid: string) => {
    if (!sid || !sessionsRef.some((s) => s.id === sid)) return
    useSessions.getState().setGroup(sid, gid)
    setActiveGroup(gid)
  }
  const spinOffGroup = (sid: string) => {
    if (!sid || !sessionsRef.some((s) => s.id === sid)) return
    const gid = createGroup()
    useSessions.getState().setGroup(sid, gid)
  }
  const createGroupAndLocal = () => {
    const gid = createGroup()
    addLocal({ groupId: gid })
  }

  const capturable = capturableSessions(sessionsRef, activeGroupId)
  const showGroupBar = !editorFocused && sessionCount > 0 && !zenMode

  const saveWorkspace = async (name: string) => {
    const { items, layout } = captureWorkspace(sessionsRef, activeGroupId)
    if (!items.length) return
    await window.devterm.workspaces.save({ id: '', name, items, layout })
    setShowSaveWs(false)
  }

  const activeGroupFlag = groupFlags[activeGroupId]
  const launchedFromId = activeGroupFlag?.launchedFromWorkspaceId

  const saveBackToWorkspace = async () => {
    if (!launchedFromId) return
    const list = await window.devterm.workspaces.list()
    const ws = list.find((w) => w.id === launchedFromId)
    if (!ws) return
    const { items, layout } = captureWorkspace(sessionsRef, activeGroupId)
    if (!items.length) return
    await window.devterm.workspaces.save({
      ...ws,
      items,
      layout
    })
  }

  const isMac = local?.os === 'mac'
  const dictateHotkey =
    resolveHotkeys(useSettings.getState().keybindings).find((h) => h.id === 'dictate') ??
    HOTKEYS.find((h) => h.id === 'dictate')
  const dictateHotkeyLabel = dictateHotkey ? comboLabel(dictateHotkey, !!isMac) : undefined

  // First-run hint: show the user's actual (possibly overridden) combos.
  const welcomeHintKeys = useMemo(() => {
    const hs = resolveHotkeys(keybindings)
    const combo = (id: HotkeyId) => {
      const h = hs.find((x) => x.id === id)
      return h ? comboLabel(h, !!isMac) : ''
    }
    return {
      palette: combo('palette'),
      newTerminal: combo('newTerminal'),
      settings: combo('settings')
    }
  }, [keybindings, isMac])

  return (
    <div className="app" data-zen={zenMode ? 'on' : undefined}>
      {!zenMode && (
        <AppToolbar
          view={view}
          setView={setView}
          setShowSidebar={setShowSidebar}
          bottomPanelMode={bottomPanelMode}
          setBottomPanelMode={setBottomPanelMode}
          local={local}
          gitPanelOpen={gitPanelOpen}
          setGitPanelOpen={(v) => setGitPanelOpen(typeof v === 'function' ? v(gitPanelOpen) : v)}
          onSettings={() => setShowSettings(true)}
          onShortcuts={() => setShowShortcuts(true)}
          dictateHotkey={dictateHotkeyLabel}
        />
      )}

      <div className="body">
        {showSidebar && !zenMode && (
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

        {gitPanelOpen && !zenMode && (
          <aside className="git-sidebar">
            <GitPanel />
          </aside>
        )}

        <div className="main">
          <div className="panes-area">
            {/*
              The terminals view stays mounted at all times — switching to
              Connections/Workspaces only hides it. Unmounting it would tear
              down every TerminalView, killing the local PTYs and dropping the
              SSH shells. Hidden via `.term-hidden` (visibility:hidden + an
              off-screen translate), never display:none: the terminals keep
              their real dimensions and stay fitted while another view is shown
              (a display-hidden terminal is 0×0 and can't refit until reveal,
              which corrupted/clipped output), and being off-screen makes xterm
              pause their render loops so a background view doesn't keep every
              terminal repainting.
            */}
            <div className={`view-pane${view === 'terminals' ? '' : ' term-hidden'}`}>
              <TerminalsView
                showGroupBar={showGroupBar}
                groups={groups}
                activeGroupId={activeGroupId}
                sessionsRef={sessionsRef}
                sessionCount={sessionCount}
                editorFocused={editorFocused}
                editorActiveId={editorActiveId}
                editorDocs={editorDocs}
                editorBlur={editorBlur}
                editorSetActive={editorSetActive}
                editorClose={editorClose}
                onNewTerminal={() => setShowPicker(true)}
                onNewTerminalInGroup={() => addLocal({ groupId: activeGroupId })}
                onCreateGrid={() => setShowGrid(true)}
                onSaveWorkspace={() => setShowSaveWs(true)}
                saveBackToWorkspace={() => void saveBackToWorkspace()}
                launchedFromId={launchedFromId}
                capturable={capturable}
                dragOverGroup={dragOverGroup}
                setDragOverGroup={setDragOverGroup}
                switchGroup={switchGroup}
                closeGroup={closeGroup}
                createGroupAndLocal={createGroupAndLocal}
                moveToGroup={moveToGroup}
                spinOffGroup={spinOffGroup}
              />
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
            {/* One-time first-run hint. Anchored bottom-center of the panes
                area (absolute within .panes-area), non-modal — only the card
                itself intercepts pointer events. */}
            {!welcomeHintSeen && view === 'terminals' && !zenMode && sessionCount > 0 && (
              <div className="welcome-hint">
                <span className="welcome-hint-title">Getting started</span>
                <span className="welcome-hint-keys">
                  <kbd>{welcomeHintKeys.palette}</kbd> palette ·{' '}
                  <kbd>{welcomeHintKeys.newTerminal}</kbd> new terminal ·{' '}
                  <kbd>{welcomeHintKeys.settings}</kbd> settings
                </span>
                <button
                  className="welcome-hint-close"
                  aria-label="Dismiss"
                  title="Dismiss"
                  onClick={() => setWelcomeHintSeen(true)}
                >
                  ×
                </button>
              </div>
            )}
          </div>

          <StatusBar />
          <TransfersPanel />
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
          onGrid={() => {
            setView('terminals')
            setShowPicker(false)
            setShowGrid(true)
          }}
          onClose={() => setShowPicker(false)}
        />
      )}
      <CreateGridModal open={showGrid} onClose={() => setShowGrid(false)} />
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
        <CommandPalette
          onRun={() => setView('terminals')}
          onClose={() => setShowPalette(false)}
          onCreateGrid={() => setShowGrid(true)}
        />
      )}
      {showShortcuts && <ShortcutsModal onClose={() => setShowShortcuts(false)} />}
      <ConfirmActionModal />
      <GlobalSearchModal
        isOpen={globalSearchOpen}
        onClose={() => setGlobalSearchOpen(false)}
        onJump={(sid) => {
          setSessionActive(sid)
          focusTerminal(sid)
          setGlobalSearchOpen(false)
        }}
      />
      {zenMode && (
        <button
          className="zen-exit"
          title="Exit zen mode"
          onClick={() => useSettings.getState().setZenMode(false)}
        >
          Exit zen mode
        </button>
      )}
      <DictationStatus />
    </div>
  )
}
