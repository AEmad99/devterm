import { create } from 'zustand'

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
  /** Bottom status bar visibility (Cluster C adds this). */
  showStatusBar: boolean
  /** Whether the agent activity panel is collapsed by default (Cluster A). */
  agentActivityCollapsed: boolean
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
  showStatusBar: true,
  agentActivityCollapsed: false
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
      showStatusBar:
        typeof parsed?.showStatusBar === 'boolean' ? parsed.showStatusBar : DEFAULTS.showStatusBar,
      agentActivityCollapsed:
        typeof parsed?.agentActivityCollapsed === 'boolean'
          ? parsed.agentActivityCollapsed
          : DEFAULTS.agentActivityCollapsed
    }
  } catch {
    return DEFAULTS
  }
}

interface SettingsState extends AppSettings {
  setThemeId: (id: string) => void
  setTerminalBg: (patch: Partial<TerminalBg>) => void
  setPrefs: (patch: Partial<TerminalPrefs>) => void
  setAutoReconnect: (patch: Partial<AutoReconnectSettings>) => void
  setShowStatusBar: (v: boolean) => void
  setAgentActivityCollapsed: (v: boolean) => void
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
        showStatusBar: state.showStatusBar,
        agentActivityCollapsed: state.agentActivityCollapsed
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
    persist({ themeId: id, terminalBg: get().terminalBg, prefs: get().prefs, autoReconnect: get().autoReconnect, showStatusBar: get().showStatusBar, agentActivityCollapsed: get().agentActivityCollapsed })
  },

  setTerminalBg: (patch) => {
    const terminalBg = { ...get().terminalBg, ...patch }
    set({ terminalBg })
    persist({ themeId: get().themeId, terminalBg, prefs: get().prefs, autoReconnect: get().autoReconnect, showStatusBar: get().showStatusBar, agentActivityCollapsed: get().agentActivityCollapsed })
  },

  setPrefs: (patch) => {
    const prefs = { ...get().prefs, ...patch }
    set({ prefs })
    persist({ themeId: get().themeId, terminalBg: get().terminalBg, prefs, autoReconnect: get().autoReconnect, showStatusBar: get().showStatusBar, agentActivityCollapsed: get().agentActivityCollapsed })
  },

  setAutoReconnect: (patch) => {
    const autoReconnect = { ...get().autoReconnect, ...patch }
    set({ autoReconnect })
    persist({ themeId: get().themeId, terminalBg: get().terminalBg, prefs: get().prefs, autoReconnect, showStatusBar: get().showStatusBar, agentActivityCollapsed: get().agentActivityCollapsed })
    // Push to the main process so the live policy updates immediately.
    void window.devterm.ssh.setReconnectPolicy?.(autoReconnect).catch(() => undefined)
  },

  setShowStatusBar: (v) => {
    set({ showStatusBar: v })
    persist({ themeId: get().themeId, terminalBg: get().terminalBg, prefs: get().prefs, autoReconnect: get().autoReconnect, showStatusBar: v, agentActivityCollapsed: get().agentActivityCollapsed })
  },

  setAgentActivityCollapsed: (v) => {
    set({ agentActivityCollapsed: v })
    persist({ themeId: get().themeId, terminalBg: get().terminalBg, prefs: get().prefs, autoReconnect: get().autoReconnect, showStatusBar: get().showStatusBar, agentActivityCollapsed: v })
  },

  reset: () => {
    set({
      themeId: DEFAULTS.themeId,
      terminalBg: DEFAULTS.terminalBg,
      prefs: DEFAULTS.prefs,
      autoReconnect: DEFAULTS.autoReconnect,
      showStatusBar: DEFAULTS.showStatusBar,
      agentActivityCollapsed: DEFAULTS.agentActivityCollapsed
    })
    persist(DEFAULTS)
    void window.devterm.ssh.setReconnectPolicy?.(DEFAULTS.autoReconnect).catch(() => undefined)
  }
}))
