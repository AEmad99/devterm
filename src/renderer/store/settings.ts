import { create } from 'zustand'
import type {
  AgentKind,
  AgentPreferences,
  DefaultShellPref,
  RemoteConnectMode,
  STTSettings,
  STTModelId,
  STTLanguage
} from '@shared/types'
import type { HotkeyId } from '../lib/hotkeys'
import { applyTheme, getTheme } from '../lib/themes'
import { applyDensity } from '../lib/density'
import {
  DEFAULT_HIBERNATE_AFTER_MS,
  DEFAULT_OUTPUT_RING_LINES,
  normalizeHibernateAfterMs,
  normalizeOutputRingLines
} from '../lib/hibernate'
import {
  DEFAULT_SEARCH_INDEX_LINES,
  PERFORMANCE_PRESETS,
  type PerformancePresetId,
  normalizeSearchIndexLines
} from '../lib/performance-presets'

/**
 * User-facing settings for terminals. Persisted to localStorage (renderer-only,
 * no secrets) so preferences survive restarts. `terminalBg` is cosmetic; `prefs`
 * holds appearance + behavior knobs applied live to every open terminal.
 */

export interface TerminalBg {
  /** Solid background colour for the terminal (also shown beneath an image). */
  color: string
  /** Optional background image: a `data:` URL (picked file) or http(s) URL. */
  image: string | null
  /** Darkening overlay over the image, 0 (none) .. 0.85 (heavy), for legibility. */
  dim: number
}

export type CursorStyle = 'block' | 'bar' | 'underline'
export type BellStyle = 'none' | 'visual'

/** Appearance + behavior preferences, applied to xterm options live. */
export interface TerminalPrefs {
  fontSize: number
  fontFamily: string
  lineHeight: number
  cursorStyle: CursorStyle
  cursorBlink: boolean
  scrollback: number
  /** Mirror the selection to the clipboard as soon as it's made. */
  copyOnSelect: boolean
  /** Right-click pastes instead of the copy-or-paste gesture. */
  rightClickPaste: boolean
  /** Mouse-wheel lines per notch (xterm scrollSensitivity). */
  scrollSensitivity: number
  /** Terminal bell handling. */
  bell: BellStyle
}

export interface AppSettings {
  /** Active theme id (see lib/themes.ts) — drives the terminal palette + app chrome. */
  themeId: string
  terminalBg: TerminalBg
  prefs: TerminalPrefs
  /** Auto-reconnect policy applied to remote SSH sessions when they drop. */
  autoReconnect: AutoReconnectSettings
  /** Attention signals (chime / OS notification / tab badge) for agents + terminals. */
  attention: AttentionSettings
  idleNotify: {
    enabled: boolean
    webhookUrl: string
    telegramChatId: string
  }
  /** Bottom status bar visibility (Cluster C adds this). */
  showStatusBar: boolean
  /** Whether the agent activity panel is collapsed by default (Cluster A). */
  agentActivityCollapsed: boolean
  /** Dim terminal panes that are not the active tab in their leaf. */
  inactivePaneDimming: boolean
  /** Open SFTP as a side pane beside the terminal instead of replacing it. */
  sftpSidePane: boolean
  /** Show running / unread-output indicators on pane tabs. */
  activityIndicators: boolean
  /** Hide the top toolbar, group bar, sidebar, and status bar for a zen layout. */
  zenMode: boolean
  /**
   * Which coding agent to launch in remote sessions. The embedded, provider-
   * agnostic DevTerm Agent is the default; external CLIs remain fallbacks.
   */
  agentKind: AgentKind
  /** Provider/model routing and resumable-session preferences for DevTerm Agent. */
  agentPreferences: AgentPreferences
  /** Offer a tmux session picker when connecting to a POSIX host that has tmux. */
  remoteDetachedSessions: boolean
  /**
   * Reopen the last session snapshot (local shells + saved SSH + layout) on
   * app start. Workspace auto-launch still wins when any workspace has it set.
   */
  sessionRestore: boolean
  /** Dispose hidden-group xterm surfaces while retaining their processes. */
  hibernateEnabled: boolean
  /** Hide the main window to the tray while keeping PTYs, SSH clients, and agents alive. */
  keepSessionsInTray: boolean
  /** Delay before a clean terminal in a hidden group is hibernated. */
  hibernateAfterMs: number
  /** Main-process raw output ring capacity for replay after hibernate. */
  outputRingLines: number
  /** Connect background restore/workspace remotes on focus or on a stagger. */
  remoteConnectMode: RemoteConnectMode
  /**
   * Whether the transfers panel is open in the bottom dock. Cluster D adds
   * this. App toolbar's segmented "Activity | Transfers | Off" toggle is the
   * canonical control; this flag mirrors its chosen value so the panel can
   * also re-hide itself on session close.
   */
  transfersPanelOpen: boolean
  /**
   * Which local shell to spawn for new terminals. Defaults to `auto` so the
   * main process picks PowerShell 7 when available (no signature-loading
   * bug), else Windows PowerShell 5.1, else cmd.exe. Override here when
   * you want a specific shell (e.g. `wsl.exe`, Git Bash, nushell).
   */
  defaultShell: DefaultShellPref
  /**
   * Whether the Git panel is shown in the right sidebar. When on, the
   * sidebar splits into a Files pane (left) and a Git pane (right).
   */
  gitPanelOpen: boolean
  /**
   * Custom keyboard shortcuts. Only overrides are stored; missing ids fall back
   * to the built-in defaults in lib/hotkeys.ts.
   */
  keybindings: Partial<
    Record<HotkeyId, { mod?: boolean; shift?: boolean; alt?: boolean; key: string }>
  >
  /** Local voice dictation (offline Whisper speech-to-text into the active terminal). */
  stt: STTSettings
  /**
   * Persist global-search lines to `userData/search/<sid>.jsonl` so they
   * survive a restart. Off by default — the in-memory index is the hot
   * path. When on, the main process tails every push (local + remote
   * PTY) so a closed session's recent output is still searchable.
   */
  searchPersist: boolean
  /** In-memory global-search ring size per session. */
  searchIndexLines: number
  /**
   * One-time onboarding hint (the floating "Getting started" card in the
   * terminals view). Flipped to true when the user dismisses it; older saved
   * payloads without the field default to false so the hint shows once.
   */
  welcomeHintSeen: boolean
  /**
   * Four-step first-run checklist. Never resurrected by settings import.
   * Completing all four hides the card permanently (also sets welcomeHintSeen).
   */
  firstRun: {
    localTerminal: boolean
    importedSsh: boolean
    openedAgent: boolean
    pickedTheme: boolean
  }
  /** Chrome density: comfortable (default) or compact manager/modal spacing. */
  density: 'comfortable' | 'compact'
  /** Pinned manager rows (connections / snippets / workspaces), shown first. */
  pinned: { connections: string[]; snippets: string[]; workspaces: string[] }
  /** Saved-connection id → last successful connect timestamp (ms). */
  lastConnectedAt: Record<string, number>
}

export type PinKind = 'connections' | 'snippets' | 'workspaces'

/**
 * User-facing knobs for the SSH auto-reconnect loop. Matches the main-process
 * `ReconnectPolicy` (kept separate so the renderer never has to import the
 * main-only types).
 */
export interface AutoReconnectSettings {
  /** Master switch. */
  enabled: boolean
  /** Total attempts (1 = single retry, 5 = 1 initial + 4 retries). */
  maxAttempts: number
  /** Delay before the first retry, in ms. */
  baseDelayMs: number
  /** Cap for any single delay, in ms. */
  maxDelayMs: number
  /** Multiplier per attempt. 2 = classic exponential. */
  factor: number
}

/**
 * Attention signals — raised when an agent (or any terminal) finishes work or
 * asks for input. The renderer decides *when* to fire (see lib/attention.ts):
 * by default only when you are NOT already looking at that session, which also
 * filters a foreground shell's own tab-completion bells. This object only holds
 * the user's preferences for *how* the alert surfaces.
 */
export interface AttentionSettings {
  /** Master switch for all attention signals. */
  enabled: boolean
  /** Play a short chime when a signal fires. */
  sound: boolean
  /** Chime loudness, 0 (silent) .. 1 (full). */
  volume: number
  /** Post an OS notification + flash the taskbar when the window is backgrounded. */
  system: boolean
  /** Treat an agent pane going quiet after a burst of output as "finished" (heuristic). */
  idle: boolean
}

export const DEFAULT_FONT_FAMILY = 'Cascadia Code, Consolas, "Courier New", monospace'

// Inlined rather than imported from lib/themes to avoid a module cycle (themes
// imports the TerminalBg type from here). Keep in sync with DEFAULT_THEME_ID.
const DEFAULT_THEME_ID = 'tokyo-night'

const DEFAULTS: AppSettings = {
  themeId: DEFAULT_THEME_ID,
  terminalBg: { color: '#16181d', image: null, dim: 0.35 },
  prefs: {
    fontSize: 14,
    fontFamily: DEFAULT_FONT_FAMILY,
    lineHeight: 1.0,
    cursorStyle: 'block',
    cursorBlink: true,
    // 10k matches modern terminal defaults (WT/iTerm); settings clamp is 100–100000.
    scrollback: 10000,
    copyOnSelect: false,
    rightClickPaste: false,
    scrollSensitivity: 1,
    bell: 'none'
  },
  autoReconnect: {
    enabled: true,
    maxAttempts: 5,
    baseDelayMs: 1000,
    maxDelayMs: 30000,
    factor: 2
  },
  attention: {
    enabled: true,
    sound: true,
    volume: 0.5,
    system: true,
    idle: true
  },
  idleNotify: { enabled: false, webhookUrl: '', telegramChatId: '' },
  showStatusBar: true,
  agentActivityCollapsed: false,
  inactivePaneDimming: true,
  sftpSidePane: false,
  activityIndicators: true,
  zenMode: false,
  agentKind: 'devterm',
  agentPreferences: {
    provider: '',
    model: '',
    fallbackModels: [],
    resumeSessions: true,
    browserTools: true,
    agentHandoff: true,
    trustedSkills: []
  },
  remoteDetachedSessions: true,
  sessionRestore: true,
  hibernateEnabled: true,
  keepSessionsInTray: false,
  hibernateAfterMs: DEFAULT_HIBERNATE_AFTER_MS,
  outputRingLines: DEFAULT_OUTPUT_RING_LINES,
  remoteConnectMode: 'focus',
  transfersPanelOpen: false,
  defaultShell: { kind: 'auto' },
  gitPanelOpen: false,
  keybindings: {},
  stt: {
    enabled: true,
    modelId: 'base',
    language: 'auto',
    appendSpace: true,
    showFloatingStatus: true
  },
  searchPersist: false,
  searchIndexLines: DEFAULT_SEARCH_INDEX_LINES,
  welcomeHintSeen: false,
  firstRun: {
    localTerminal: false,
    importedSsh: false,
    openedAgent: false,
    pickedTheme: false
  },
  density: 'comfortable',
  pinned: { connections: [], snippets: [], workspaces: [] },
  lastConnectedAt: {}
}

const STORAGE_KEY = 'devterm.settings.v1'

function isAgentKind(value: unknown): value is AgentKind {
  return (
    value === 'devterm' ||
    value === 'claude' ||
    value === 'pi' ||
    value === 'opencode' ||
    value === 'kimi' ||
    value === 'grok' ||
    value === 'codex' ||
    value === 'antigravity' ||
    value === 'muse'
  )
}

function load(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULTS
    const parsed = JSON.parse(raw)
    const prefs = { ...DEFAULTS.prefs, ...(parsed?.prefs ?? {}) }
    // Merge over defaults so older saved files (which had no `prefs`) and any
    // future-added fields fall back cleanly.
    return {
      themeId: typeof parsed?.themeId === 'string' ? parsed.themeId : DEFAULTS.themeId,
      terminalBg: { ...DEFAULTS.terminalBg, ...(parsed?.terminalBg ?? {}) },
      prefs,
      autoReconnect: { ...DEFAULTS.autoReconnect, ...(parsed?.autoReconnect ?? {}) },
      attention: { ...DEFAULTS.attention, ...(parsed?.attention ?? {}) },
      idleNotify: {
        ...DEFAULTS.idleNotify,
        ...(parsed?.idleNotify && typeof parsed.idleNotify === 'object' ? parsed.idleNotify : {})
      },
      showStatusBar:
        typeof parsed?.showStatusBar === 'boolean' ? parsed.showStatusBar : DEFAULTS.showStatusBar,
      agentActivityCollapsed:
        typeof parsed?.agentActivityCollapsed === 'boolean'
          ? parsed.agentActivityCollapsed
          : DEFAULTS.agentActivityCollapsed,
      inactivePaneDimming:
        typeof parsed?.inactivePaneDimming === 'boolean'
          ? parsed.inactivePaneDimming
          : DEFAULTS.inactivePaneDimming,
      sftpSidePane:
        typeof parsed?.sftpSidePane === 'boolean' ? parsed.sftpSidePane : DEFAULTS.sftpSidePane,
      activityIndicators:
        typeof parsed?.activityIndicators === 'boolean'
          ? parsed.activityIndicators
          : DEFAULTS.activityIndicators,
      zenMode: typeof parsed?.zenMode === 'boolean' ? parsed.zenMode : DEFAULTS.zenMode,
      agentKind: isAgentKind(parsed?.agentKind) ? parsed.agentKind : DEFAULTS.agentKind,
      agentPreferences: normalizeAgentPreferences(parsed?.agentPreferences),
      remoteDetachedSessions:
        typeof parsed?.remoteDetachedSessions === 'boolean'
          ? parsed.remoteDetachedSessions
          : DEFAULTS.remoteDetachedSessions,
      sessionRestore:
        typeof parsed?.sessionRestore === 'boolean'
          ? parsed.sessionRestore
          : DEFAULTS.sessionRestore,
      hibernateEnabled:
        typeof parsed?.hibernateEnabled === 'boolean'
          ? parsed.hibernateEnabled
          : DEFAULTS.hibernateEnabled,
      keepSessionsInTray:
        typeof parsed?.keepSessionsInTray === 'boolean'
          ? parsed.keepSessionsInTray
          : DEFAULTS.keepSessionsInTray,
      hibernateAfterMs: normalizeHibernateAfterMs(
        parsed?.hibernateAfterMs ?? DEFAULTS.hibernateAfterMs
      ),
      outputRingLines: normalizeOutputRingLines(
        parsed?.outputRingLines,
        normalizeOutputRingLines(prefs.scrollback, DEFAULTS.outputRingLines)
      ),
      remoteConnectMode: parsed?.remoteConnectMode === 'stagger' ? 'stagger' : 'focus',
      transfersPanelOpen:
        typeof parsed?.transfersPanelOpen === 'boolean'
          ? parsed.transfersPanelOpen
          : DEFAULTS.transfersPanelOpen,
      defaultShell: normalizeDefaultShell(parsed?.defaultShell),
      gitPanelOpen:
        typeof parsed?.gitPanelOpen === 'boolean' ? parsed.gitPanelOpen : DEFAULTS.gitPanelOpen,
      keybindings: normalizeKeybindings(parsed?.keybindings),
      stt: normalizeStt(parsed?.stt),
      searchPersist:
        typeof parsed?.searchPersist === 'boolean' ? parsed.searchPersist : DEFAULTS.searchPersist,
      searchIndexLines: normalizeSearchIndexLines(
        parsed?.searchIndexLines,
        DEFAULTS.searchIndexLines
      ),
      welcomeHintSeen:
        typeof parsed?.welcomeHintSeen === 'boolean'
          ? parsed.welcomeHintSeen
          : DEFAULTS.welcomeHintSeen,
      firstRun: normalizeFirstRun(parsed?.firstRun),
      density: parsed?.density === 'compact' ? 'compact' : DEFAULTS.density,
      pinned: normalizePinned(parsed?.pinned),
      lastConnectedAt: normalizeLastConnected(parsed?.lastConnectedAt)
    }
  } catch {
    return DEFAULTS
  }
}

/**
 * Validate the persisted defaultShell against the supported variants. Older
 * saves (or hand-edited localStorage) with an unknown `kind` quietly fall back
 * to `auto` so the renderer never hands the main process garbage.
 */
function normalizeFirstRun(raw: unknown): AppSettings['firstRun'] {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  return {
    localTerminal: o.localTerminal === true,
    importedSsh: o.importedSsh === true,
    openedAgent: o.openedAgent === true,
    pickedTheme: o.pickedTheme === true
  }
}

function firstRunComplete(fr: AppSettings['firstRun']): boolean {
  return fr.localTerminal && fr.importedSsh && fr.openedAgent && fr.pickedTheme
}

function normalizePinned(raw: unknown): AppSettings['pinned'] {
  const empty = { connections: [], snippets: [], workspaces: [] }
  if (!raw || typeof raw !== 'object') return empty
  const pick = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 200) : []
  const r = raw as Record<string, unknown>
  return {
    connections: pick(r.connections),
    snippets: pick(r.snippets),
    workspaces: pick(r.workspaces)
  }
}

function normalizeLastConnected(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== 'object') return {}
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k.slice(0, 120)] = v
  }
  return out
}

function normalizeDefaultShell(raw: unknown): DefaultShellPref {
  if (raw && typeof raw === 'object') {
    const r = raw as { kind?: unknown; path?: unknown }
    if (r.kind === 'auto' || r.kind === 'pwsh' || r.kind === 'powershell' || r.kind === 'cmd') {
      return { kind: r.kind }
    }
    if (r.kind === 'custom' && typeof r.path === 'string' && r.path.length > 0) {
      return { kind: 'custom', path: r.path }
    }
  }
  return DEFAULTS.defaultShell
}

function normalizeKeybindings(raw: unknown): AppSettings['keybindings'] {
  if (!raw || typeof raw !== 'object') return DEFAULTS.keybindings
  const out: AppSettings['keybindings'] = {}
  for (const [id, combo] of Object.entries(raw as Record<string, unknown>)) {
    if (!combo || typeof combo !== 'object') continue
    const c = combo as { mod?: unknown; shift?: unknown; alt?: unknown; key?: unknown }
    if (typeof c.key !== 'string' || c.key.length === 0) continue
    out[id as HotkeyId] = {
      mod: c.mod === true,
      shift: c.shift === true,
      alt: c.alt === true,
      key: c.key.length === 1 ? c.key.toLowerCase() : c.key
    }
  }
  return out
}

/**
 * Validate the persisted STT settings. Unknown model ids / languages fall back
 * to defaults so a hand-edited or older localStorage never breaks the worker.
 */
function normalizeStt(raw: unknown): STTSettings {
  if (!raw || typeof raw !== 'object') return DEFAULTS.stt
  const r = raw as Partial<STTSettings>
  const models: STTModelId[] = ['tiny', 'base', 'small']
  const languages: STTLanguage[] = [
    'auto',
    'en',
    'es',
    'fr',
    'de',
    'it',
    'pt',
    'nl',
    'ru',
    'zh',
    'ja',
    'ko',
    'ar',
    'hi'
  ]
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : DEFAULTS.stt.enabled,
    modelId: models.includes(r.modelId as STTModelId)
      ? (r.modelId as STTModelId)
      : DEFAULTS.stt.modelId,
    language: languages.includes(r.language as STTLanguage)
      ? (r.language as STTLanguage)
      : DEFAULTS.stt.language,
    appendSpace: typeof r.appendSpace === 'boolean' ? r.appendSpace : DEFAULTS.stt.appendSpace,
    showFloatingStatus:
      typeof r.showFloatingStatus === 'boolean'
        ? r.showFloatingStatus
        : DEFAULTS.stt.showFloatingStatus
  }
}

function normalizeAgentPreferences(raw: unknown): AgentPreferences {
  if (!raw || typeof raw !== 'object') return DEFAULTS.agentPreferences
  const value = raw as Partial<AgentPreferences>
  return {
    provider: typeof value.provider === 'string' ? value.provider.slice(0, 120) : '',
    model: typeof value.model === 'string' ? value.model.slice(0, 240) : '',
    fallbackModels: Array.isArray(value.fallbackModels)
      ? value.fallbackModels
          .filter((item): item is string => typeof item === 'string' && item.includes('/'))
          .map((item) => item.slice(0, 240))
          .slice(0, 12)
      : [],
    resumeSessions:
      typeof value.resumeSessions === 'boolean'
        ? value.resumeSessions
        : DEFAULTS.agentPreferences.resumeSessions,
    browserTools:
      typeof value.browserTools === 'boolean'
        ? value.browserTools
        : DEFAULTS.agentPreferences.browserTools,
    agentHandoff:
      typeof value.agentHandoff === 'boolean'
        ? value.agentHandoff
        : DEFAULTS.agentPreferences.agentHandoff,
    trustedSkills: Array.isArray(value.trustedSkills)
      ? value.trustedSkills
          .filter(
            (skill) =>
              skill &&
              typeof skill.name === 'string' &&
              typeof skill.path === 'string' &&
              typeof skill.sha256 === 'string' &&
              /^[a-f0-9]{64}$/i.test(skill.sha256)
          )
          .map((skill) => ({
            name: skill.name.slice(0, 120),
            path: skill.path,
            sha256: skill.sha256.toLowerCase(),
            enabled: skill.enabled !== false
          }))
          .slice(0, 24)
      : []
  }
}

interface SettingsState extends AppSettings {
  setThemeId: (id: string) => void
  setTerminalBg: (patch: Partial<TerminalBg>) => void
  setPrefs: (patch: Partial<TerminalPrefs>) => void
  setAutoReconnect: (patch: Partial<AutoReconnectSettings>) => void
  setAttention: (patch: Partial<AttentionSettings>) => void
  setIdleNotify: (patch: Partial<AppSettings['idleNotify']>) => void
  setShowStatusBar: (v: boolean) => void
  setAgentActivityCollapsed: (v: boolean) => void
  setInactivePaneDimming: (v: boolean) => void
  setSftpSidePane: (v: boolean) => void
  setActivityIndicators: (v: boolean) => void
  setZenMode: (v: boolean) => void
  setAgentKind: (v: AgentKind) => void
  setAgentPreferences: (patch: Partial<AgentPreferences>) => void
  setRemoteDetachedSessions: (v: boolean) => void
  setSessionRestore: (v: boolean) => void
  setHibernateEnabled: (v: boolean) => void
  setKeepSessionsInTray: (v: boolean) => void
  setHibernateAfterMs: (v: number) => void
  setOutputRingLines: (v: number) => void
  setRemoteConnectMode: (v: RemoteConnectMode) => void
  setTransfersPanelOpen: (v: boolean) => void
  setDefaultShell: (pref: DefaultShellPref) => void
  setGitPanelOpen: (v: boolean) => void
  setKeybinding: (
    id: HotkeyId,
    combo: { mod?: boolean; shift?: boolean; alt?: boolean; key: string } | null
  ) => void
  resetKeybindings: () => void
  setStt: (patch: Partial<STTSettings>) => void
  /** Toggle the optional persistent search index tail (off by default). */
  setSearchPersist: (v: boolean) => void
  setSearchIndexLines: (v: number) => void
  applyPerformancePreset: (id: PerformancePresetId) => void
  /** Dismiss the one-time first-run welcome hint. */
  setWelcomeHintSeen: (v: boolean) => void
  markFirstRun: (step: keyof AppSettings['firstRun']) => void
  setDensity: (v: AppSettings['density']) => void
  /** Pin/unpin a manager row (connections / snippets / workspaces). */
  togglePin: (kind: PinKind, id: string) => void
  /** Record a successful connect for "last connected" display. */
  recordConnected: (id: string) => void
  /**
   * Apply an imported settings snapshot (received from `settings:imported`)
   * to the live store and localStorage. Unknown/missing fields fall back to
   * the existing value rather than the default — the snapshot is merged
   * with defaults on the main side, so this is the authoritative shape.
   * Also pushes the live SSH reconnect policy to main since the renderer's
   * setter normally does that.
   */
  applyImported: (s: import('@shared/types').SettingsSnapshot) => void
  reset: () => void
}

function persist(state: AppSettings): void {
  const payload: AppSettings = {
    themeId: state.themeId,
    terminalBg: state.terminalBg,
    prefs: state.prefs,
    autoReconnect: state.autoReconnect,
    attention: state.attention,
    idleNotify: state.idleNotify,
    showStatusBar: state.showStatusBar,
    agentActivityCollapsed: state.agentActivityCollapsed,
    inactivePaneDimming: state.inactivePaneDimming,
    sftpSidePane: state.sftpSidePane,
    activityIndicators: state.activityIndicators,
    zenMode: state.zenMode,
    agentKind: state.agentKind,
    agentPreferences: state.agentPreferences,
    remoteDetachedSessions: state.remoteDetachedSessions,
    sessionRestore: state.sessionRestore,
    hibernateEnabled: state.hibernateEnabled,
    keepSessionsInTray: state.keepSessionsInTray,
    hibernateAfterMs: state.hibernateAfterMs,
    outputRingLines: state.outputRingLines,
    remoteConnectMode: state.remoteConnectMode,
    transfersPanelOpen: state.transfersPanelOpen,
    defaultShell: state.defaultShell,
    gitPanelOpen: state.gitPanelOpen,
    keybindings: state.keybindings,
    stt: state.stt,
    searchPersist: state.searchPersist,
    searchIndexLines: state.searchIndexLines,
    welcomeHintSeen: state.welcomeHintSeen,
    firstRun: state.firstRun,
    density: state.density,
    pinned: state.pinned,
    lastConnectedAt: state.lastConnectedAt
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
  } catch {
    /* storage full / unavailable — settings simply won't persist */
  }
  // Fire-and-forget push to main so `userData/settings.json` stays canonical
  // for the settings export bundle. Settings live in renderer localStorage;
  // main mirrors the snapshot. A sync failure here never affects the live UI.
  try {
    window.devterm.settingsIo.sync(payload)
  } catch {
    /* preload bridge not ready (e.g. very early boot) — ignore */
  }
}

export const useSettings = create<SettingsState>((set, get) => ({
  ...load(),

  setThemeId: (id) => {
    const firstRun = { ...get().firstRun, pickedTheme: true }
    const done = firstRunComplete(firstRun)
    set({
      themeId: id,
      firstRun,
      welcomeHintSeen: done ? true : get().welcomeHintSeen
    })
    persist(snapshot(get()))
  },

  setTerminalBg: (patch) => {
    const terminalBg = { ...get().terminalBg, ...patch }
    set({ terminalBg })
    persist(snapshot(get()))
  },

  setPrefs: (patch) => {
    const prefs = { ...get().prefs, ...patch }
    set({ prefs })
    persist(snapshot(get()))
  },

  setAutoReconnect: (patch) => {
    const autoReconnect = { ...get().autoReconnect, ...patch }
    set({ autoReconnect })
    persist(snapshot(get()))
    // Push to the main process so the live policy updates immediately.
    void window.devterm.ssh.setReconnectPolicy?.(autoReconnect).catch(() => undefined)
  },

  setAttention: (patch) => {
    const attention = { ...get().attention, ...patch }
    set({ attention })
    persist(snapshot(get()))
  },

  setIdleNotify: (patch) => {
    const idleNotify = { ...get().idleNotify, ...patch }
    set({ idleNotify })
    persist(snapshot(get()))
    void window.devterm.notify
      .setSecrets({
        webhookUrl: idleNotify.webhookUrl,
        telegramChatId: idleNotify.telegramChatId
      })
      .catch(() => undefined)
  },

  setShowStatusBar: (v) => {
    set({ showStatusBar: v })
    persist(snapshot(get()))
  },

  setAgentActivityCollapsed: (v) => {
    set({ agentActivityCollapsed: v })
    persist(snapshot(get()))
  },

  setInactivePaneDimming: (v) => {
    set({ inactivePaneDimming: v })
    persist(snapshot(get()))
  },

  setSftpSidePane: (v) => {
    set({ sftpSidePane: v })
    persist(snapshot(get()))
  },

  setActivityIndicators: (v) => {
    set({ activityIndicators: v })
    persist(snapshot(get()))
  },

  setZenMode: (v) => {
    set({ zenMode: v })
    persist(snapshot(get()))
  },

  setAgentKind: (v) => {
    set({ agentKind: v })
    persist(snapshot(get()))
  },

  setAgentPreferences: (patch) => {
    const agentPreferences = normalizeAgentPreferences({ ...get().agentPreferences, ...patch })
    set({ agentPreferences })
    persist(snapshot(get()))
  },

  setRemoteDetachedSessions: (v) => {
    set({ remoteDetachedSessions: v })
    persist(snapshot(get()))
  },

  setSessionRestore: (v) => {
    set({ sessionRestore: v })
    persist(snapshot(get()))
  },

  setHibernateEnabled: (v) => {
    set({ hibernateEnabled: v })
    persist(snapshot(get()))
  },

  setKeepSessionsInTray: (v) => {
    set({ keepSessionsInTray: v })
    persist(snapshot(get()))
  },

  setHibernateAfterMs: (v) => {
    set({ hibernateAfterMs: normalizeHibernateAfterMs(v) })
    persist(snapshot(get()))
  },

  setOutputRingLines: (v) => {
    set({ outputRingLines: normalizeOutputRingLines(v) })
    persist(snapshot(get()))
  },

  setRemoteConnectMode: (v) => {
    set({ remoteConnectMode: v === 'stagger' ? 'stagger' : 'focus' })
    persist(snapshot(get()))
  },

  setTransfersPanelOpen: (v) => {
    set({ transfersPanelOpen: v })
    persist(snapshot(get()))
  },

  setDefaultShell: (pref) => {
    set({ defaultShell: pref })
    persist(snapshot(get()))
  },

  setGitPanelOpen: (v) => {
    set({ gitPanelOpen: v })
    persist(snapshot(get()))
  },

  setKeybinding: (id, combo) => {
    const keybindings = { ...get().keybindings }
    if (combo) keybindings[id] = combo
    else delete keybindings[id]
    set({ keybindings })
    persist(snapshot(get()))
  },

  resetKeybindings: () => {
    set({ keybindings: DEFAULTS.keybindings })
    persist(snapshot(get()))
  },

  setStt: (patch) => {
    const stt = { ...get().stt, ...patch }
    set({ stt })
    persist(snapshot(get()))
  },

  setSearchPersist: (v) => {
    set({ searchPersist: v })
    persist(snapshot(get()))
  },

  setSearchIndexLines: (v) => {
    set({ searchIndexLines: normalizeSearchIndexLines(v) })
    persist(snapshot(get()))
  },

  applyPerformancePreset: (id) => {
    const preset = PERFORMANCE_PRESETS[id]
    if (!preset) return
    const v = preset.values
    const prefs = { ...get().prefs, scrollback: v.scrollback }
    set({
      prefs,
      hibernateEnabled: v.hibernateEnabled,
      hibernateAfterMs: v.hibernateAfterMs,
      outputRingLines: v.outputRingLines,
      searchIndexLines: v.searchIndexLines,
      remoteConnectMode: v.remoteConnectMode
    })
    persist(snapshot(get()))
  },

  setWelcomeHintSeen: (v) => {
    set({ welcomeHintSeen: v })
    persist(snapshot(get()))
  },

  markFirstRun: (step) => {
    const firstRun = { ...get().firstRun, [step]: true }
    const done = firstRunComplete(firstRun)
    set({ firstRun, welcomeHintSeen: done ? true : get().welcomeHintSeen })
    persist(snapshot(get()))
  },

  setDensity: (v) => {
    set({ density: v })
    persist(snapshot(get()))
  },

  togglePin: (kind, id) => {
    const cur = get().pinned[kind]
    const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]
    set({ pinned: { ...get().pinned, [kind]: next } })
    persist(snapshot(get()))
  },

  recordConnected: (id) => {
    set({ lastConnectedAt: { ...get().lastConnectedAt, [id]: Date.now() } })
    persist(snapshot(get()))
  },

  applyImported: (s) => {
    if (!s || typeof s !== 'object') return
    // Merge over current state so a partial snapshot (older bundle) doesn't
    // wipe fields the bundle didn't carry. Every field is independently
    // type-checked via the `??` fallbacks.
    const cur = get()
    const next: AppSettings = {
      themeId: typeof s.themeId === 'string' ? s.themeId : cur.themeId,
      terminalBg: s.terminalBg ? { ...cur.terminalBg, ...s.terminalBg } : cur.terminalBg,
      prefs: s.prefs ? { ...cur.prefs, ...s.prefs } : cur.prefs,
      autoReconnect: s.autoReconnect
        ? { ...cur.autoReconnect, ...s.autoReconnect }
        : cur.autoReconnect,
      attention: s.attention ? { ...cur.attention, ...s.attention } : cur.attention,
      idleNotify: cur.idleNotify,
      showStatusBar: typeof s.showStatusBar === 'boolean' ? s.showStatusBar : cur.showStatusBar,
      agentActivityCollapsed:
        typeof s.agentActivityCollapsed === 'boolean'
          ? s.agentActivityCollapsed
          : cur.agentActivityCollapsed,
      inactivePaneDimming:
        typeof s.inactivePaneDimming === 'boolean'
          ? s.inactivePaneDimming
          : cur.inactivePaneDimming,
      sftpSidePane: typeof s.sftpSidePane === 'boolean' ? s.sftpSidePane : cur.sftpSidePane,
      activityIndicators:
        typeof s.activityIndicators === 'boolean' ? s.activityIndicators : cur.activityIndicators,
      zenMode: typeof s.zenMode === 'boolean' ? s.zenMode : cur.zenMode,
      agentKind: isAgentKind(s.agentKind) ? s.agentKind : cur.agentKind,
      agentPreferences: s.agentPreferences
        ? normalizeAgentPreferences({ ...cur.agentPreferences, ...s.agentPreferences })
        : cur.agentPreferences,
      remoteDetachedSessions:
        typeof s.remoteDetachedSessions === 'boolean'
          ? s.remoteDetachedSessions
          : cur.remoteDetachedSessions,
      sessionRestore: typeof s.sessionRestore === 'boolean' ? s.sessionRestore : cur.sessionRestore,
      hibernateEnabled:
        typeof s.hibernateEnabled === 'boolean' ? s.hibernateEnabled : cur.hibernateEnabled,
      keepSessionsInTray:
        typeof s.keepSessionsInTray === 'boolean' ? s.keepSessionsInTray : cur.keepSessionsInTray,
      hibernateAfterMs:
        s.hibernateAfterMs !== undefined
          ? normalizeHibernateAfterMs(s.hibernateAfterMs)
          : cur.hibernateAfterMs,
      outputRingLines:
        s.outputRingLines !== undefined
          ? normalizeOutputRingLines(s.outputRingLines)
          : cur.outputRingLines,
      remoteConnectMode:
        s.remoteConnectMode === 'stagger' || s.remoteConnectMode === 'focus'
          ? s.remoteConnectMode
          : cur.remoteConnectMode,
      transfersPanelOpen:
        typeof s.transfersPanelOpen === 'boolean' ? s.transfersPanelOpen : cur.transfersPanelOpen,
      defaultShell: s.defaultShell ? normalizeDefaultShell(s.defaultShell) : cur.defaultShell,
      gitPanelOpen: typeof s.gitPanelOpen === 'boolean' ? s.gitPanelOpen : cur.gitPanelOpen,
      keybindings: s.keybindings ? normalizeKeybindings(s.keybindings) : cur.keybindings,
      stt: s.stt ? normalizeStt(s.stt) : cur.stt,
      searchPersist: typeof s.searchPersist === 'boolean' ? s.searchPersist : cur.searchPersist,
      searchIndexLines:
        s.searchIndexLines !== undefined
          ? normalizeSearchIndexLines(s.searchIndexLines)
          : cur.searchIndexLines,
      // Local-only UI flag (not part of the export bundle): importing settings
      // must not resurrect the dismissed welcome hint.
      welcomeHintSeen: cur.welcomeHintSeen,
      firstRun: cur.firstRun,
      density: s.density === 'compact' || s.density === 'comfortable' ? s.density : cur.density,
      pinned: s.pinned ? normalizePinned(s.pinned) : cur.pinned,
      lastConnectedAt: s.lastConnectedAt
        ? normalizeLastConnected(s.lastConnectedAt)
        : cur.lastConnectedAt
    }
    set(next)
    persist(next)
    // The setter side-effects won't fire when we `set()` directly:
    //  • repaint chrome for an imported theme (terminals already update live)
    //  • push the imported reconnect policy to the SSH manager
    applyTheme(getTheme(next.themeId))
    applyDensity(next.density)
    void window.devterm.ssh.setReconnectPolicy?.(next.autoReconnect).catch(() => undefined)
  },

  reset: () => {
    set({
      themeId: DEFAULTS.themeId,
      terminalBg: DEFAULTS.terminalBg,
      prefs: DEFAULTS.prefs,
      autoReconnect: DEFAULTS.autoReconnect,
      attention: DEFAULTS.attention,
      idleNotify: DEFAULTS.idleNotify,
      showStatusBar: DEFAULTS.showStatusBar,
      agentActivityCollapsed: DEFAULTS.agentActivityCollapsed,
      inactivePaneDimming: DEFAULTS.inactivePaneDimming,
      sftpSidePane: DEFAULTS.sftpSidePane,
      activityIndicators: DEFAULTS.activityIndicators,
      zenMode: DEFAULTS.zenMode,
      agentKind: DEFAULTS.agentKind,
      agentPreferences: DEFAULTS.agentPreferences,
      remoteDetachedSessions: DEFAULTS.remoteDetachedSessions,
      sessionRestore: DEFAULTS.sessionRestore,
      hibernateEnabled: DEFAULTS.hibernateEnabled,
      keepSessionsInTray: DEFAULTS.keepSessionsInTray,
      hibernateAfterMs: DEFAULTS.hibernateAfterMs,
      outputRingLines: DEFAULTS.outputRingLines,
      remoteConnectMode: DEFAULTS.remoteConnectMode,
      transfersPanelOpen: DEFAULTS.transfersPanelOpen,
      defaultShell: DEFAULTS.defaultShell,
      gitPanelOpen: DEFAULTS.gitPanelOpen,
      keybindings: DEFAULTS.keybindings,
      stt: DEFAULTS.stt,
      searchPersist: DEFAULTS.searchPersist,
      searchIndexLines: DEFAULTS.searchIndexLines,
      welcomeHintSeen: DEFAULTS.welcomeHintSeen,
      firstRun: DEFAULTS.firstRun,
      density: DEFAULTS.density,
      pinned: DEFAULTS.pinned,
      lastConnectedAt: DEFAULTS.lastConnectedAt
    })
    persist(DEFAULTS)
    void window.devterm.ssh.setReconnectPolicy?.(DEFAULTS.autoReconnect).catch(() => undefined)
  }
}))

/**
 * Re-apply imported settings to the live store as soon as main fires
 * `settings:imported` (after a successful import). Wired once at module
 * load so it survives component remounts. `applyImported` itself is part
 * of the store so callers can also trigger it directly.
 */
if (typeof window !== 'undefined' && window.devterm?.settingsIo) {
  window.devterm.settingsIo.onImported((snapshot) => {
    if (snapshot) useSettings.getState().applyImported(snapshot)
  })
}

/** Build a plain `AppSettings` snapshot from the live store (used by every
 * setter so we don't have to repeat the same set of fields on every call). */
function snapshot(s: SettingsState): AppSettings {
  return {
    themeId: s.themeId,
    terminalBg: s.terminalBg,
    prefs: s.prefs,
    autoReconnect: s.autoReconnect,
    attention: s.attention,
    idleNotify: s.idleNotify,
    showStatusBar: s.showStatusBar,
    agentActivityCollapsed: s.agentActivityCollapsed,
    inactivePaneDimming: s.inactivePaneDimming,
    sftpSidePane: s.sftpSidePane,
    activityIndicators: s.activityIndicators,
    zenMode: s.zenMode,
    agentKind: s.agentKind,
    agentPreferences: s.agentPreferences,
    remoteDetachedSessions: s.remoteDetachedSessions,
    sessionRestore: s.sessionRestore,
    hibernateEnabled: s.hibernateEnabled,
    keepSessionsInTray: s.keepSessionsInTray,
    hibernateAfterMs: s.hibernateAfterMs,
    outputRingLines: s.outputRingLines,
    remoteConnectMode: s.remoteConnectMode,
    transfersPanelOpen: s.transfersPanelOpen,
    defaultShell: s.defaultShell,
    gitPanelOpen: s.gitPanelOpen,
    keybindings: s.keybindings,
    stt: s.stt,
    searchPersist: s.searchPersist,
    searchIndexLines: s.searchIndexLines,
    welcomeHintSeen: s.welcomeHintSeen,
    firstRun: s.firstRun,
    density: s.density,
    pinned: s.pinned,
    lastConnectedAt: s.lastConnectedAt
  }
}
