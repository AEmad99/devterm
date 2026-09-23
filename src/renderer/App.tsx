import { useEffect, useMemo, useRef, useState } from 'react'
import ConnectionForm from './components/connections/ConnectionForm'
import FileExplorer from './components/files/FileExplorer'
import ConfirmActionModal from './components/modals/ConfirmActionModal'
import ConfirmDialog from './components/common/ConfirmDialog'
import AgentsOverviewModal from './components/agent/AgentsOverviewModal'
import { IconClose } from './components/common/Icons'
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
import SideRail from './components/chrome/SideRail'
import TerminalsView from './components/chrome/TerminalsView'
import StatusBar from './components/chrome/StatusBar'
import TransfersPanel from './components/transfers/TransfersPanel'
import { useTransfersSync } from './lib/useTransfersSync'
import { useSessions } from './store/sessions'
import { useEditors } from './store/editors'
import { useLayout, DEFAULT_GROUP, groupActiveSession, allLeaves } from './store/layout'
import { useSettings } from './store/settings'
import {
  matchHotkey,
  resolveHotkeys,
  comboLabel,
  HOTKEYS,
  isHotkeyCaptureActive,
  type HotkeyId
} from './lib/hotkeys'
import {
  focusTerminal,
  clearTerminal,
  openTerminalFind,
  openTmuxPicker,
  revealTerminalLine
} from './lib/terms'
import {
  activateWorkspaceGroup,
  capturableSessions,
  captureWorkspace,
  launchWorkspaceIntoGroup
} from './lib/workspace'
import {
  activateRestoredGroup,
  persistSessionRestore,
  restoreSessionSnapshot,
  type RestoreProgress
} from './lib/session-restore'
import { sessionCloseGuard, hasUnsavedEditors } from './lib/close-guard'
import { dictation } from './lib/stt/dictation'
import { useDictation } from './store/dictation'
import { REMOTE_CONNECT_STAGGER_MS } from './lib/remote-connect'
import DictationStatus from './components/dictation/DictationStatus'
import Toasts from './components/common/Toasts'
import ModalShell from './components/common/ModalShell'
import Button from './components/common/Button'
import ModalFooter from './components/common/ModalFooter'
import { toast } from './store/toasts'
import GitPanel from './components/git/GitPanel'
import { initBrowserControl } from './lib/browser-control'
import { initAgentHandoff } from './lib/agent-handoff'
import { initPreviewControl } from './lib/preview'
import PreviewOpenModal, { type PreviewOpenKind } from './components/modals/PreviewOpenModal'
import type { HostContext } from '@shared/types'
import type { LibraryId } from './components/chrome/types'

/** Survives an error-boundary remount so recovery does not launch every session again. */
let appStartupStarted = false

function restoreStructureKey(): string {
  const sessions = useSessions
    .getState()
    .sessions.filter((s) => !s.id.startsWith('pending-') || (s.deferredRemote && !s.closed))
    .map((s) => ({
      id: s.id,
      kind: s.kind,
      groupId: s.groupId,
      connectionId: s.connectionId,
      title: s.customTitle ? s.title : undefined,
      url: s.kind === 'browser' ? s.url : undefined,
      browserTabs: s.kind === 'browser' ? s.browserTabs : undefined,
      browserActiveTab: s.kind === 'browser' ? s.browserActiveTab : undefined,
      sshDraft:
        s.kind === 'remote' && !s.connectionId && s.restoreProfile
          ? {
              host: s.restoreProfile.host,
              port: s.restoreProfile.port,
              username: s.restoreProfile.username,
              privateKeyPath: s.restoreProfile.privateKeyPath,
              jump: s.restoreProfile.jump
                ? Array.isArray(s.restoreProfile.jump)
                  ? s.restoreProfile.jump.map((h) => ({
                      host: h.host,
                      port: h.port,
                      username: h.username,
                      privateKeyPath: h.privateKeyPath
                    }))
                  : {
                      host: s.restoreProfile.jump.host,
                      port: s.restoreProfile.jump.port,
                      username: s.restoreProfile.jump.username,
                      privateKeyPath: s.restoreProfile.jump.privateKeyPath
                    }
                : undefined
            }
          : undefined
    }))
  const groups = useLayout.getState().groups.map((g) => ({
    id: g.id,
    name: g.name,
    root: g.root
  }))
  return JSON.stringify({ sessions, groups })
}

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
  useEffect(() => initPreviewControl(), [])
  const zenMode = useSettings((s) => s.zenMode)
  const gitPanelOpen = useSettings((s) => s.gitPanelOpen)
  const setGitPanelOpen = useSettings((s) => s.setGitPanelOpen)
  const markFirstRun = useSettings((s) => s.markFirstRun)
  const keybindings = useSettings((s) => s.keybindings)

  useEffect(() => {
    if (sessionsRef.some((s) => s.kind === 'local' && !s.closed)) markFirstRun('localTerminal')
    if (sessionsRef.some((s) => s.agentUiMode)) markFirstRun('openedAgent')
  }, [sessionsRef, markFirstRun])

  const [showConnect, setShowConnect] = useState(false)
  const [showPicker, setShowPicker] = useState(false)
  const [showGrid, setShowGrid] = useState(false)
  const [showSaveWs, setShowSaveWs] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showPalette, setShowPalette] = useState(false)
  const [showShortcuts, setShowShortcuts] = useState(false)
  const [showAgents, setShowAgents] = useState(false)
  const [previewOpen, setPreviewOpen] = useState<PreviewOpenKind | null>(null)
  const [restoreNotice, setRestoreNotice] = useState<string | null>(null)
  const [restoreProgress, setRestoreProgress] = useState<RestoreProgress | null>(null)
  const [startupHydrated, setStartupHydrated] = useState(false)
  const startupHydratedRef = useRef(false)
  const preserveRestoreSnapshotRef = useRef(false)
  const hydratedStructureRef = useRef('')
  /**
   * Pending destructive close awaiting confirmation (tab, group, or editor).
   * `reasons` is rendered in the dialog; `run` performs the close on confirm.
   */
  const [pendingClose, setPendingClose] = useState<{
    title: string
    message: string
    confirmLabel: string
    run: () => void
  } | null>(null)
  const [infoNotice, setInfoNotice] = useState<{ title: string; message: string } | null>(null)
  const [dragOverGroup, setDragOverGroup] = useState<string | null>(null)
  const [library, setLibrary] = useState<LibraryId | null>(null)
  const [libraryWidth, setLibraryWidth] = useState(280)
  const [gitWidth, setGitWidth] = useState(280)
  const [local, setLocal] = useState<HostContext | null>(null)
  const [globalSearchOpen, setGlobalSearchOpen] = useState(false)
  const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))

  useEffect(() => window.devterm.app.onNotice((message) => toast(message, 'err')), [])

  useEffect(() => {
    window.devterm.localContext().then(setLocal)
    if (appStartupStarted) {
      startupHydratedRef.current = true
      setStartupHydrated(true)
      return
    }
    appStartupStarted = true
    // Boot order:
    //  1) Workspaces with autoLaunch (operator-chosen presets win)
    //  2) Last-session restore (if enabled and a snapshot exists) — always
    //     runs, even alongside auto-launched workspaces, so a browser/agent
    //     estate is never silently dropped
    //  3) One local shell in the home group, so a fresh run is one group
    //     with one terminal. Restored history keeps its own groups.
    void (async () => {
      // Until a complete load/restore proves otherwise, preserve any previous
      // snapshot. Startup service failures must not turn it into one local tab.
      let preserveRestoreSnapshot = useSettings.getState().sessionRestore
      try {
        // Apply the persisted policy before restored SSH sessions can drop.
        // Otherwise startup connections briefly use the main process defaults.
        await window.devterm.ssh
          .setReconnectPolicy?.(useSettings.getState().autoReconnect)
          ?.catch(() => undefined)

        const wsList = await window.devterm.workspaces.list()
        const toAutoLaunch = wsList.filter((w) => w.autoLaunch)
        if (toAutoLaunch.length > 0) {
          const conns = await window.devterm.connections.list()
          let firstAutoGroupId: string | null = null
          for (const [index, ws] of toAutoLaunch.entries()) {
            // `recordLaunch: false` — auto-launching on app boot doesn't count
            // as an operator-initiated launch.
            const launched = await launchWorkspaceIntoGroup(ws, conns, {
              recordLaunch: false,
              activate: index === 0
            })
            firstAutoGroupId ??= launched.groupId
            if (firstAutoGroupId) {
              useLayout.getState().setActiveGroup(firstAutoGroupId)
              const firstSession = groupActiveSession(
                useLayout.getState().groups.find((g) => g.id === firstAutoGroupId)
              )
              if (firstSession) useSessions.getState().setActive(firstSession)
            }
            if (index > 0 && useSettings.getState().remoteConnectMode === 'stagger') {
              window.setTimeout(
                () => void activateWorkspaceGroup(launched.groupId),
                index * REMOTE_CONNECT_STAGGER_MS
              )
            }
          }
        }
        if (useSettings.getState().sessionRestore) {
          try {
            const snap = await window.devterm.sessionRestore.load()
            if (snap?.groups?.length) {
              const conns = await window.devterm.connections.list()
              const { opened, attempted, incomplete } = await restoreSessionSnapshot(snap, conns, {
                onProgress: setRestoreProgress
              })
              preserveRestoreSnapshot = incomplete || opened < attempted
              if (opened > 0) {
                if (!useSessions.getState().sessions.some((s) => s.kind === 'remote')) {
                  setRestoreNotice(
                    `Restored ${opened} terminal${opened === 1 ? '' : 's'} from your last session.`
                  )
                }
              }
            } else {
              preserveRestoreSnapshot = false
            }
          } catch {
            /* fall through to empty local */
          }
        }
      } catch (err) {
        console.error('[startup] failed to restore sessions:', err)
      } finally {
        if (useSessions.getState().sessions.length === 0) {
          addLocal({ groupId: useLayout.getState().activeGroupId || DEFAULT_GROUP })
        }
        const liveSessions = useSessions.getState().sessions
        useLayout.getState().sync(liveSessions.map((s) => ({ id: s.id, groupId: s.groupId })))
        preserveRestoreSnapshotRef.current = preserveRestoreSnapshot
        hydratedStructureRef.current = restoreStructureKey()
        startupHydratedRef.current = true
        setStartupHydrated(true)
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // A group tab can be selected by the group bar, a tray notification, or a
  // keyboard action. Whichever surface wins, focusing the group is the single
  // trigger for its painted remote tabs to start connecting.
  useEffect(() => {
    void activateRestoredGroup(activeGroupId)
    void activateWorkspaceGroup(activeGroupId)
  }, [activeGroupId])

  // Agent UI modes can change from a floating OS window; apply locally so the
  // main session store (docked/hidden/floating chrome) stays in sync.
  useEffect(() => {
    return window.devterm.agent.onUiModeChanged(({ sessionId, mode }) => {
      useSessions.getState().setAgentUi(sessionId, { mode }, { localOnly: true })
    })
  }, [])

  // A floating agent window finishing a turn badges the matching tab here.
  useEffect(() => {
    return window.devterm.window.onAgentAttention((sessionId) => {
      useSessions.getState().setNeedsAttention(sessionId, true)
    })
  }, [])

  // Notification/tray click: jump to the exact session that wants attention.
  useEffect(() => {
    return window.devterm.window.onFocusSession((sid) => {
      const s = useSessions.getState().sessions.find((x) => x.id === sid)
      if (!s) return
      useLayout.getState().setActiveGroup(s.groupId || DEFAULT_GROUP)
      useSessions.getState().setActive(sid)
      focusTerminal(sid)
      setLibrary(null)
    })
  }, [])

  // Window/taskbar title follows the active session so a minimized window is
  // identifiable in the taskbar and Alt+Tab.
  const activeSessionId = useSessions((s) => s.activeId)
  useEffect(() => {
    const active = sessionsRef.find((s) => s.id === activeSessionId)
    document.title = active ? `DevTerm — ${active.title}` : 'DevTerm'
  }, [sessionsRef, activeSessionId])

  // Keep the main process informed about unsaved editor buffers so the window
  // close guard can include them in its confirmation.
  useEffect(() => {
    window.devterm.window.setCloseGuard(hasUnsavedEditors())
  }, [editorDocs])

  // Restore feedback is transient — users should know the layout came back.
  useEffect(() => {
    if (!restoreNotice) return
    const t = window.setTimeout(() => setRestoreNotice(null), 6000)
    return () => window.clearTimeout(t)
  }, [restoreNotice])

  useEffect(() => {
    if (!restoreProgress?.activeSettled) return
    const t = window.setTimeout(
      () => setRestoreProgress(null),
      restoreProgress.failures.length ? 12_000 : 6_000
    )
    return () => window.clearTimeout(t)
  }, [
    restoreProgress?.activeSettled,
    restoreProgress?.failures.length,
    restoreProgress?.ready,
    restoreProgress?.total
  ])

  // Debounced last-session snapshot so a crash/quit can reopen the layout.
  useEffect(() => {
    // Do not overwrite the last complete snapshot with an empty/partial one
    // while slow SSH sessions are still being restored.
    if (!startupHydrated || !useSettings.getState().sessionRestore) return
    if (preserveRestoreSnapshotRef.current) {
      // If some restored sessions were unreachable, retain the complete prior
      // snapshot until the operator makes a structural session/layout change.
      // Status/cwd churn alone must not erase remotes that are temporarily
      // unavailable (for example, while a VPN is disconnected).
      if (restoreStructureKey() === hydratedStructureRef.current) return
      preserveRestoreSnapshotRef.current = false
    }
    const t = window.setTimeout(() => {
      void persistSessionRestore()
    }, 1500)
    return () => clearTimeout(t)
  }, [startupHydrated, sessionsRef, groups])

  // Flush restore snapshot on page hide / unload (best-effort).
  useEffect(() => {
    const flush = () => {
      if (
        startupHydratedRef.current &&
        !preserveRestoreSnapshotRef.current &&
        useSettings.getState().sessionRestore
      ) {
        void persistSessionRestore()
      }
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

  const requestCloseSession = (sid: string) => {
    const s = useSessions.getState().sessions.find((x) => x.id === sid)
    const guard = sessionCloseGuard(s)
    if (!guard.needed) {
      doCloseSession(sid)
      return
    }
    setPendingClose({
      title: 'Close terminal?',
      message: `Closing this terminal stops ${guard.reasons.join(' and ')}.`,
      confirmLabel: 'Close',
      run: () => doCloseSession(sid)
    })
  }

  const isTerminalHostFocused = (): boolean => {
    if (typeof document === 'undefined') return false
    const el = document.activeElement as HTMLElement | null
    if (!el) return false
    return !!el.closest?.('.terminal-host')
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isHotkeyCaptureActive()) {
        e.preventDefault()
        e.stopPropagation()
        return
      }
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
        if (id === 'previewMarkdown') {
          const ed = useEditors.getState()
          const doc = ed.docs.find((d) => d.id === ed.activeId)
          if (!ed.focused || !doc) return
          e.preventDefault()
          ed.cyclePreviewMode(doc.id)
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
            setShowPicker(true)
            break
          case 'newGrid':
            setShowGrid(true)
            break
          case 'closeTerminal': {
            const activeId = useSessions.getState().activeId
            if (activeId) requestCloseSession(activeId)
            break
          }
          case 'duplicateTerminal':
            void duplicateActive()
            break
          case 'toggleSidebar':
            setLibrary((cur) => (cur === 'files' ? null : 'files'))
            break
          case 'clearTerminal': {
            const activeId = useSessions.getState().activeId
            if (activeId) clearTerminal(activeId)
            break
          }
          case 'zoomIn':
          case 'zoomInAlt':
          case 'zoomInAlt2':
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
          case 'newGroup':
            createGroupAndLocal()
            break
          case 'nextGroup':
            cycleGroup(1)
            break
          case 'prevGroup':
            cycleGroup(-1)
            break
          case 'splitRight':
            splitActive('right')
            break
          case 'splitDown':
            splitActive('bottom')
            break
          case 'agents':
            setShowAgents((v) => !v)
            break
          case 'toggleGit': {
            const s = useSettings.getState()
            s.setGitPanelOpen(!s.gitPanelOpen)
            break
          }
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
        // Zen mode is a full-window mode; Esc must leave it like every other
        // immersive surface.
        if (useSettings.getState().zenMode) {
          e.preventDefault()
          useSettings.getState().setZenMode(false)
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
      if (isHotkeyCaptureActive()) return
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
  const focusRestoreFailure = (failure: RestoreProgress['failures'][number]) => {
    if (!failure.sessionId) return
    const session = useSessions.getState().sessions.find((s) => s.id === failure.sessionId)
    if (!session) return
    setActiveGroup(failure.groupId)
    setSessionActive(failure.sessionId)
    setLibrary(null)
    focusTerminal(failure.sessionId)
  }
  const editorCloseForSession = useEditors((s) => s.closeForSession)
  const doCloseSession = (sid: string) => {
    editorCloseForSession(sid)
    closeSession(sid)
  }
  const closeGroupNow = (gid: string) => {
    useSessions
      .getState()
      .sessions.filter((s) => (s.groupId || DEFAULT_GROUP) === gid)
      .forEach((s) => doCloseSession(s.id))
  }
  const requestCloseGroup = (gid: string) => {
    // Read live state — this can be invoked from the []-deps keydown handler.
    const members = useSessions
      .getState()
      .sessions.filter((s) => (s.groupId || DEFAULT_GROUP) === gid)
    if (!members.length) return
    const reasons = new Set<string>()
    for (const s of members) sessionCloseGuard(s).reasons.forEach((r) => reasons.add(r))
    if (!reasons.size && members.length === 1) {
      closeGroupNow(gid)
      return
    }
    setPendingClose({
      title: 'Close group?',
      message: `This closes ${members.length} terminal${members.length === 1 ? '' : 's'}${
        reasons.size ? `, including ${[...reasons].join(' and ')}` : ''
      }.`,
      confirmLabel: 'Close group',
      run: () => closeGroupNow(gid)
    })
  }

  /** Split the active session's pane with a fresh local shell. */
  const splitActive = (zone: 'right' | 'bottom') => {
    const { activeId, sessions: list } = useSessions.getState()
    const s = list.find((x) => x.id === activeId)
    if (!s || s.kind === 'browser') return
    const gid = s.groupId || DEFAULT_GROUP
    const newId = addLocal({ groupId: gid })
    useLayout
      .getState()
      .sync([...list, { id: newId, groupId: gid }].map((x) => ({ id: x.id, groupId: x.groupId })))
    useLayout.getState().splitBeside(s.id, newId, zone)
    setSessionActive(newId)
    focusTerminal(newId)
  }

  const cycleGroup = (dir: 1 | -1) => {
    const { groups: gs, activeGroupId: cur } = useLayout.getState()
    if (gs.length < 2) return
    const idx = gs.findIndex((g) => g.id === cur)
    const next = gs[(idx + dir + gs.length) % gs.length]
    if (next) switchGroup(next.id)
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
    if (!ws) {
      // Restored groups carry a synthetic workspace id; there is nothing to
      // update. Clear the stale flag and tell the operator what happened
      // instead of leaving an enabled button that silently does nothing.
      useLayout.getState().clearGroupLaunched(activeGroupId)
      setInfoNotice({
        title: 'No saved workspace',
        message:
          'This group came from a session snapshot rather than a saved workspace, so there is nothing to save back to. Use "Save as new" to create a workspace.'
      })
      return
    }
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
  // The same resolver feeds the sidebar tooltips so they stay in sync with
  // user keybinding overrides.
  const hotkeyLabel = useMemo(() => {
    const hs = resolveHotkeys(keybindings)
    return (id: HotkeyId) => {
      const h = hs.find((x) => x.id === id)
      return h ? comboLabel(h, !!isMac) : ''
    }
  }, [keybindings, isMac])
  const toggleLibrary = (id: LibraryId) => {
    setLibrary((cur) => (cur === id ? null : id))
    if (id !== 'files') setLibraryWidth((w) => Math.max(w, 440))
  }
  return (
    <div className="app" data-zen={zenMode ? 'on' : undefined}>
      <div className="body">
        {!zenMode && (
          <SideRail
            active={library}
            onToggle={toggleLibrary}
            filesHotkey={hotkeyLabel('toggleSidebar')}
            gitPanelOpen={gitPanelOpen}
            onToggleGit={() => setGitPanelOpen(!gitPanelOpen)}
            onSettings={() => setShowSettings(true)}
            onShortcuts={() => setShowShortcuts(true)}
            dictateHotkey={dictateHotkeyLabel}
            hotkeyLabel={hotkeyLabel}
          />
        )}
        {library && !zenMode && (
          <>
            <aside className="library-panel" style={{ width: libraryWidth }}>
              {library === 'files' && <FileExplorer />}
              {library === 'connections' && (
                <ConnectionsManager onConnect={() => setLibrary(null)} />
              )}
              {library === 'workspaces' && <WorkspacesManager onLaunch={() => setLibrary(null)} />}
              {library === 'snippets' && <SnippetsManager onRun={() => setLibrary(null)} />}
            </aside>
            <Splitter
              direction="horizontal"
              onDelta={(d) => setLibraryWidth((w) => clamp(w + d, 320, 640))}
            />
          </>
        )}

        <div className="main">
          <div className="panes-area">
            {/*
              Terminals stay mounted for the life of the window. Library panels
              open beside them. Unmounting this view would tear down every
              TerminalView, killing local PTYs and dropping SSH shells.
            */}
            <div className="view-pane">
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
                closeGroup={requestCloseGroup}
                onRequestCloseSession={requestCloseSession}
                createGroupAndLocal={createGroupAndLocal}
                moveToGroup={moveToGroup}
                spinOffGroup={spinOffGroup}
              />
            </div>
          </div>

          <StatusBar />
          {!zenMode && <TransfersPanel />}
        </div>

        {gitPanelOpen && !zenMode && (
          <>
            <Splitter
              direction="horizontal"
              onDelta={(d) => setGitWidth((w) => clamp(w + d, 220, 480))}
            />
            <aside className="git-sidebar" style={{ width: gitWidth }}>
              <GitPanel />
            </aside>
          </>
        )}
      </div>

      {showPicker && (
        <NewTerminalModal
          onLocal={() => {
            addLocal()
            setShowPicker(false)
          }}
          onRemote={() => {
            setShowPicker(false)
            setShowConnect(true)
          }}
          onBrowser={() => {
            addBrowser()
            setShowPicker(false)
          }}
          onGrid={() => {
            setShowPicker(false)
            setShowGrid(true)
          }}
          onClose={() => setShowPicker(false)}
        />
      )}
      <CreateGridModal
        open={showGrid}
        onClose={() => setShowGrid(false)}
        onCreated={(result) => {
          if (result.errors.length) {
            setRestoreNotice(
              `Grid opened ${result.created}/${result.requested}: ${result.errors[0]}`
            )
          }
        }}
        onSettled={(result) => {
          if (result.errors.length) {
            setRestoreNotice(
              `Grid opened ${result.created}/${result.requested} cells — ${result.errors[0]}`
            )
          }
        }}
      />
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
          onRun={() => setLibrary(null)}
          onClose={() => setShowPalette(false)}
          onCreateGrid={() => setShowGrid(true)}
          onNewRemote={() => setShowConnect(true)}
          onSettings={() => setShowSettings(true)}
          onShortcuts={() => setShowShortcuts(true)}
          onGlobalSearch={() => setGlobalSearchOpen(true)}
          onAgents={() => setShowAgents(true)}
          onPreview={(kind) => setPreviewOpen(kind)}
        />
      )}
      <PreviewOpenModal
        open={!!previewOpen}
        kind={previewOpen ?? 'localhost'}
        onClose={() => setPreviewOpen(null)}
        onFocusTerminals={() => setLibrary(null)}
      />
      {showShortcuts && <ShortcutsModal onClose={() => setShowShortcuts(false)} />}
      <AgentsOverviewModal open={showAgents} onClose={() => setShowAgents(false)} />
      <ModalShell
        open={!!infoNotice}
        onClose={() => setInfoNotice(null)}
        title={infoNotice?.title ?? ''}
        size="sm"
        footer={
          <ModalFooter>
            <Button variant="primary" onClick={() => setInfoNotice(null)}>
              OK
            </Button>
          </ModalFooter>
        }
      >
        {infoNotice?.message}
      </ModalShell>
      <ConfirmDialog
        open={!!pendingClose}
        title={pendingClose?.title ?? ''}
        message={pendingClose?.message ?? ''}
        confirmLabel={pendingClose?.confirmLabel ?? 'Close'}
        onConfirm={() => {
          pendingClose?.run()
          setPendingClose(null)
        }}
        onClose={() => setPendingClose(null)}
      />
      <ConfirmActionModal />
      <GlobalSearchModal
        isOpen={globalSearchOpen}
        onClose={() => setGlobalSearchOpen(false)}
        onJump={(sid, line, total) => {
          // Bring the owning group/leaf forward so a hidden pane is visible
          // before focusing, then scroll to the matched line.
          const s = useSessions.getState().sessions.find((x) => x.id === sid)
          if (s) {
            const gid = s.groupId || DEFAULT_GROUP
            useLayout.getState().setActiveGroup(gid)
            const g = useLayout.getState().groups.find((x) => x.id === gid)
            if (g?.root) {
              const leaf = allLeaves(g.root).find((l) => l.tabs.includes(sid))
              if (leaf) useLayout.getState().setActiveTab(leaf.id, sid)
            }
          }
          setSessionActive(sid)
          setLibrary(null)
          focusTerminal(sid)
          revealTerminalLine(sid, line, total)
          setGlobalSearchOpen(false)
        }}
      />
      {zenMode && (
        <button
          className="zen-exit"
          title="Exit zen mode (Ctrl/Cmd+Alt+Z)"
          aria-label="Exit zen mode"
          onClick={() => useSettings.getState().setZenMode(false)}
        >
          <IconClose size={12} />
          Exit zen
        </button>
      )}
      <DictationStatus />
      {restoreProgress && restoreProgress.total > 0 && (
        <div className="app-toast restore-progress-toast" role="status">
          <div>
            {restoreProgress.activeSettled ? 'Restore' : 'Restoring'} remotes:{' '}
            <strong>
              {restoreProgress.ready}/{restoreProgress.total} hosts up
            </strong>
            {restoreProgress.pending > 0 && (
              <span> · {restoreProgress.pending} connect when focused</span>
            )}
          </div>
          {restoreProgress.failures.length > 0 && (
            <div className="restore-progress-errors">
              {restoreProgress.failures.map((failure, index) =>
                failure.sessionId ? (
                  <button
                    key={`${failure.sessionId}-${index}`}
                    type="button"
                    onClick={() => focusRestoreFailure(failure)}
                    title="Focus failed remote tab"
                  >
                    {failure.title}: {failure.message}
                  </button>
                ) : (
                  <span key={`${failure.groupId}-${index}`}>
                    {failure.title}: {failure.message}
                  </span>
                )
              )}
            </div>
          )}
        </div>
      )}
      {restoreNotice && !restoreProgress && (
        <div className="app-toast" role="status">
          {restoreNotice}
        </div>
      )}
      <Toasts />
    </div>
  )
}
