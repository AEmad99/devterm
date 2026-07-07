import { create } from 'zustand'
import type { AgentKind, DefaultShellPref } from '@shared/types'
import type { HotkeyId } from '../lib/hotkeys'

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
  /** Bottom status bar visibility (Cluster C adds this). */
  showStatusBar: boolean
  /** Whether the agent activity panel is collapsed by default (Cluster A). */
  agentActivityCollapsed: boolean
  /**
   * Which coding agent (`claude`, `pi`, or `opencode`) to launch in remote
   * sessions. Mirrors the per-session agent picker; the picker writes the
   * last-used choice here so it persists across launches and restarts.
   * First-ever default is `claude`.
   */
  agentKind: AgentKind
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
   * Custom keyboard shortcuts. Only overrides are stored; missing ids fall back
   * to the built-in defaults in lib/hotkeys.ts.
   */
  keybindings: Partial<
    Record<HotkeyId, { mod?: boolean; shift?: boolean; alt?: boolean; key: string }>
  >
}

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
    scrollback: 1000,
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
  showStatusBar: true,
  agentActivityCollapsed: false,
  agentKind: 'claude',
  transfersPanelOpen: false,
  defaultShell: { kind: 'auto' },
  keybindings: {}
}

const STORAGE_KEY = 'devterm.settings.v1'

function load(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULTS
    const parsed = JSON.parse(raw)
    // Merge over defaults so older saved files (which had no `prefs`) and any
    // future-added fields fall back cleanly.
    return {
      themeId: typeof parsed?.themeId === 'string' ? parsed.themeId : DEFAULTS.themeId,
      terminalBg: { ...DEFAULTS.terminalBg, ...(parsed?.terminalBg ?? {}) },
      prefs: { ...DEFAULTS.prefs, ...(parsed?.prefs ?? {}) },
      autoReconnect: { ...DEFAULTS.autoReconnect, ...(parsed?.autoReconnect ?? {}) },
      attention: { ...DEFAULTS.attention, ...(parsed?.attention ?? {}) },
      showStatusBar:
        typeof parsed?.showStatusBar === 'boolean' ? parsed.showStatusBar : DEFAULTS.showStatusBar,
      agentActivityCollapsed:
        typeof parsed?.agentActivityCollapsed === 'boolean'
          ? parsed.agentActivityCollapsed
          : DEFAULTS.agentActivityCollapsed,
      agentKind:
        parsed?.agentKind === 'claude' ||
        parsed?.agentKind === 'pi' ||
        parsed?.agentKind === 'opencode' ||
        parsed?.agentKind === 'kimi' ||
        parsed?.agentKind === 'grok' ||
        parsed?.agentKind === 'codex'
          ? parsed.agentKind
          : DEFAULTS.agentKind,
      transfersPanelOpen:
        typeof parsed?.transfersPanelOpen === 'boolean'
          ? parsed.transfersPanelOpen
          : DEFAULTS.transfersPanelOpen,
      defaultShell: normalizeDefaultShell(parsed?.defaultShell),
      keybindings: normalizeKeybindings(parsed?.keybindings)
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
      key: c.key
    }
  }
  return out
}

interface SettingsState extends AppSettings {
  setThemeId: (id: string) => void
  setTerminalBg: (patch: Partial<TerminalBg>) => void
  setPrefs: (patch: Partial<TerminalPrefs>) => void
  setAutoReconnect: (patch: Partial<AutoReconnectSettings>) => void
  setAttention: (patch: Partial<AttentionSettings>) => void
  setShowStatusBar: (v: boolean) => void
  setAgentActivityCollapsed: (v: boolean) => void
  setAgentKind: (v: AgentKind) => void
  setTransfersPanelOpen: (v: boolean) => void
  setDefaultShell: (pref: DefaultShellPref) => void
  setKeybinding: (
    id: HotkeyId,
    combo: { mod?: boolean; shift?: boolean; alt?: boolean; key: string } | null
  ) => void
  resetKeybindings: () => void
  reset: () => void
}

function persist(state: AppSettings): void {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        themeId: state.themeId,
        terminalBg: state.terminalBg,
        prefs: state.prefs,
        autoReconnect: state.autoReconnect,
        attention: state.attention,
        showStatusBar: state.showStatusBar,
        agentActivityCollapsed: state.agentActivityCollapsed,
        agentKind: state.agentKind,
        transfersPanelOpen: state.transfersPanelOpen,
        defaultShell: state.defaultShell,
        keybindings: state.keybindings
      })
    )
  } catch {
    /* storage full / unavailable — settings simply won't persist */
  }
}

export const useSettings = create<SettingsState>((set, get) => ({
  ...load(),

  setThemeId: (id) => {
    set({ themeId: id })
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

  setShowStatusBar: (v) => {
    set({ showStatusBar: v })
    persist(snapshot(get()))
  },

  setAgentActivityCollapsed: (v) => {
    set({ agentActivityCollapsed: v })
    persist(snapshot(get()))
  },

  setAgentKind: (v) => {
    set({ agentKind: v })
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

  reset: () => {
    set({
      themeId: DEFAULTS.themeId,
      terminalBg: DEFAULTS.terminalBg,
      prefs: DEFAULTS.prefs,
      autoReconnect: DEFAULTS.autoReconnect,
      attention: DEFAULTS.attention,
      showStatusBar: DEFAULTS.showStatusBar,
      agentActivityCollapsed: DEFAULTS.agentActivityCollapsed,
      agentKind: DEFAULTS.agentKind,
      transfersPanelOpen: DEFAULTS.transfersPanelOpen,
      defaultShell: DEFAULTS.defaultShell,
      keybindings: DEFAULTS.keybindings
    })
    persist(DEFAULTS)
    void window.devterm.ssh.setReconnectPolicy?.(DEFAULTS.autoReconnect).catch(() => undefined)
  }
}))

/** Build a plain `AppSettings` snapshot from the live store (used by every
 * setter so we don't have to repeat the same set of fields on every call). */
function snapshot(s: SettingsState): AppSettings {
  return {
    themeId: s.themeId,
    terminalBg: s.terminalBg,
    prefs: s.prefs,
    autoReconnect: s.autoReconnect,
    attention: s.attention,
    showStatusBar: s.showStatusBar,
    agentActivityCollapsed: s.agentActivityCollapsed,
    agentKind: s.agentKind,
    transfersPanelOpen: s.transfersPanelOpen,
    defaultShell: s.defaultShell,
    keybindings: s.keybindings
  }
}
