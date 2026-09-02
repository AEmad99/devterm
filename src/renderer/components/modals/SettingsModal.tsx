import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type CSSProperties
} from 'react'
import { useSettings } from '../../store/settings'
import { useSessions } from '../../store/sessions'
import { useShallow } from 'zustand/react/shallow'
import type {
  AgentCapabilities,
  AppUpdateCheckResult,
  ApprovalRule,
  DefaultShellPref,
  PerformanceSnapshot
} from '@shared/types'
import { THEMES, getTheme, applyTheme, type Theme } from '../../lib/themes'
import { HOTKEYS, comboLabel, captureCombo, type HotkeyId } from '../../lib/hotkeys'
import { chime } from '../../lib/attention'
import {
  IconClose,
  IconLocal,
  IconPalette,
  IconTerminals,
  IconGroup,
  IconSettings,
  IconKeyboard,
  IconMic,
  IconRefresh
} from '../common/Icons'

/** Latest GitHub release notes (changelog) for this product. */
const CHANGELOG_URL = 'https://github.com/AEmad99/devterm/releases/latest'

const FONT_PRESETS = [
  'Cascadia Code, Consolas, "Courier New", monospace',
  'Consolas, monospace',
  'JetBrains Mono, monospace',
  'Fira Code, monospace',
  'Menlo, Monaco, monospace',
  'Courier New, monospace'
]

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))

type SettingsTab =
  | 'general'
  | 'appearance'
  | 'terminal'
  | 'layout'
  | 'agent'
  | 'hotkeys'
  | 'dictation'
  | 'system'

const TAB_TITLES: Record<SettingsTab, string> = {
  general: 'General & Shell',
  appearance: 'Appearance & Themes',
  terminal: 'Terminal & Font',
  layout: 'Layout & Panes',
  agent: 'DevTerm Agent & Guardrails',
  hotkeys: 'Keybindings',
  dictation: 'Voice & Dictation',
  system: 'System, Performance & Backup'
}

/** Compact labels for the sidebar — the full titles headline each pane. */
const TAB_NAV_LABELS: Record<SettingsTab, string> = {
  general: 'General & Shell',
  appearance: 'Appearance',
  terminal: 'Terminal & Font',
  layout: 'Layout & Panes',
  agent: 'DevTerm Agent',
  hotkeys: 'Keybindings',
  dictation: 'Voice Dictation',
  system: 'System & Data'
}

const TAB_SUBTITLES: Record<SettingsTab, string> = {
  general: 'Default shell, QuickConnect and session startup',
  layout: 'Pane arrangement, tab strips and focus mode',
  appearance: 'Themes, window chrome and accent colors',
  terminal: 'Font, cursor, scrollback and rendering',
  agent: 'Model routing, fallbacks and guardrail policy',
  hotkeys: 'Rebind application shortcuts',
  dictation: 'Push-to-talk Whisper dictation and models',
  system: 'Version, updates, performance snapshot and backups'
}

const TAB_ICONS: Record<SettingsTab, ComponentType<{ size?: number }>> = {
  general: IconLocal,
  layout: IconGroup,
  appearance: IconPalette,
  terminal: IconTerminals,
  agent: IconSettings,
  hotkeys: IconKeyboard,
  dictation: IconMic,
  system: IconRefresh
}

/** Sidebar ordering: related categories grouped under a small section label
    instead of one flat list of eight. */
const NAV_GROUPS: Array<{ label: string; tabs: SettingsTab[] }> = [
  { label: 'Workspace', tabs: ['general', 'layout'] },
  { label: 'Appearance', tabs: ['appearance', 'terminal'] },
  { label: 'Agent', tabs: ['agent'] },
  { label: 'Input', tabs: ['hotkeys', 'dictation'] },
  { label: 'System', tabs: ['system'] }
]

/** A live mini-preview of a theme: a tiny terminal window with a prompt + colours. */
function ThemeSwatch({
  theme,
  active,
  onPick
}: {
  theme: Theme
  active: boolean
  onPick: () => void
}) {
  const t = theme.terminal
  return (
    <button
      className={`theme-swatch ${active ? 'active' : ''} ${theme.glass ? 'is-glass' : ''}`}
      onClick={onPick}
      title={theme.name}
    >
      <span
        className="theme-swatch-preview"
        style={
          {
            background: t.background,
            borderColor: theme.chrome.border,
            '--sw-accent': theme.chrome.accent,
            '--sw-accent2': theme.chrome.accent2 ?? theme.chrome.accent
          } as CSSProperties
        }
      >
        <span className="tsw-glow" aria-hidden="true" />
        <span className="tsw-line">
          <span style={{ color: t.green }}>~</span>
          <span style={{ color: t.blue }}>$</span>
          <span style={{ color: t.foreground }}>npm</span>
          <span style={{ color: t.yellow }}>run</span>
        </span>
        <span className="tsw-line">
          <span style={{ color: t.magenta }}>git</span>
          <span style={{ color: t.cyan }}>push</span>
          <span className="tsw-caret" style={{ background: t.cursor }} />
        </span>
        <span className="tsw-dots">
          {[t.red, t.green, t.yellow, t.blue, t.magenta, t.cyan].map((c, i) => (
            <span key={i} style={{ background: c }} />
          ))}
        </span>
      </span>
      <span className="theme-swatch-name">
        {theme.name}
        {theme.glass && <span className="theme-tag">Glass</span>}
      </span>
    </button>
  )
}

/**
 * Settings — overhauled 2-pane dialog with categorized sidebar, cards, and polished text.
 */
export default function SettingsModal({ onClose }: { onClose: () => void }) {
  const [activeTab, setActiveTab] = useState<SettingsTab>('general')
  const themeId = useSettings((s) => s.themeId)
  const setThemeId = useSettings((s) => s.setThemeId)
  const terminalBg = useSettings((s) => s.terminalBg)
  const setTerminalBg = useSettings((s) => s.setTerminalBg)
  const prefs = useSettings((s) => s.prefs)
  const setPrefs = useSettings((s) => s.setPrefs)
  const autoReconnect = useSettings((s) => s.autoReconnect)
  const setAutoReconnect = useSettings((s) => s.setAutoReconnect)
  const attention = useSettings((s) => s.attention)
  const setAttention = useSettings((s) => s.setAttention)
  const reset = useSettings((s) => s.reset)
  const defaultShell = useSettings((s) => s.defaultShell)
  const setDefaultShell = useSettings((s) => s.setDefaultShell)
  const keybindings = useSettings((s) => s.keybindings)
  const setKeybinding = useSettings((s) => s.setKeybinding)
  const resetKeybindings = useSettings((s) => s.resetKeybindings)
  const inactivePaneDimming = useSettings((s) => s.inactivePaneDimming)
  const setInactivePaneDimming = useSettings((s) => s.setInactivePaneDimming)
  const sftpSidePane = useSettings((s) => s.sftpSidePane)
  const setSftpSidePane = useSettings((s) => s.setSftpSidePane)
  const activityIndicators = useSettings((s) => s.activityIndicators)
  const setActivityIndicators = useSettings((s) => s.setActivityIndicators)
  const searchPersist = useSettings((s) => s.searchPersist)
  const setSearchPersist = useSettings((s) => s.setSearchPersist)
  const zenMode = useSettings((s) => s.zenMode)
  const setZenMode = useSettings((s) => s.setZenMode)
  const stt = useSettings((s) => s.stt)
  const setStt = useSettings((s) => s.setStt)
  const agentPreferences = useSettings((s) => s.agentPreferences)
  const setAgentPreferences = useSettings((s) => s.setAgentPreferences)
  const remoteDetachedSessions = useSettings((s) => s.remoteDetachedSessions)
  const setRemoteDetachedSessions = useSettings((s) => s.setRemoteDetachedSessions)
  const sessionRestore = useSettings((s) => s.sessionRestore)
  const setSessionRestore = useSettings((s) => s.setSessionRestore)

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [shellHint, setShellHint] = useState<string | null>(null)
  const [pwshBusy, setPwshBusy] = useState(false)
  const [ioHint, setIoHint] = useState<string | null>(null)
  const [capturing, setCapturing] = useState<HotkeyId | null>(null)
  const [sttHint, setSttHint] = useState<string | null>(null)
  const [agentCapabilities, setAgentCapabilities] = useState<AgentCapabilities | null>(null)
  const [agentCapabilitiesError, setAgentCapabilitiesError] = useState<string | null>(null)
  const [agentCapabilitiesBusy, setAgentCapabilitiesBusy] = useState(false)
  const [fallbackDraft, setFallbackDraft] = useState(agentPreferences.fallbackModels.join(', '))
  const [performance, setPerformance] = useState<PerformanceSnapshot | null>(null)
  const [appVersion, setAppVersion] = useState<string | null>(null)
  const [updateBusy, setUpdateBusy] = useState(false)
  const [updateResult, setUpdateResult] = useState<AppUpdateCheckResult | null>(null)

  // Agent guardrails (approval rules) state
  const [rules, setRules] = useState<ApprovalRule[]>([])
  const [rulePrefix, setRulePrefix] = useState('')
  const [ruleOutcome, setRuleOutcome] = useState<ApprovalRule['outcome']>('allow')
  const [ruleScope, setRuleScope] = useState<'global' | 'session'>('global')
  const [ruleSessionId, setRuleSessionId] = useState('')
  const [ruleBusy, setRuleBusy] = useState(false)
  const [ruleHint, setRuleHint] = useState<string | null>(null)
  const hintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    setFallbackDraft(agentPreferences.fallbackModels.join(', '))
  }, [agentPreferences.fallbackModels])

  useEffect(() => {
    return () => {
      if (hintTimerRef.current) {
        clearTimeout(hintTimerRef.current)
        hintTimerRef.current = null
      }
    }
  }, [])

  const refreshAgentCapabilities = useCallback(async (forceRefresh = false) => {
    setAgentCapabilitiesBusy(true)
    setAgentCapabilitiesError(null)
    try {
      setAgentCapabilities(await window.devterm.agent.capabilities(forceRefresh))
    } catch (e) {
      setAgentCapabilitiesError((e as Error).message || String(e))
    } finally {
      setAgentCapabilitiesBusy(false)
    }
  }, [])

  const addTrustedSkill = async () => {
    try {
      const skill = await window.devterm.agent.chooseSkill()
      if (!skill) return
      const withoutSamePath = agentPreferences.trustedSkills.filter(
        (existing) => existing.path !== skill.path
      )
      setAgentPreferences({ trustedSkills: [...withoutSamePath, skill] })
    } catch (e) {
      setAgentCapabilitiesError((e as Error).message || String(e))
    }
  }

  useEffect(() => {
    void refreshAgentCapabilities()
    let active = true
    void window.devterm.app
      .getVersion()
      .then((v) => {
        if (active) setAppVersion(v)
      })
      .catch(() => undefined)
    const refreshPerformance = () => {
      void window.devterm.performance
        .snapshot()
        .then((snapshot) => {
          if (active) setPerformance(snapshot)
        })
        .catch(() => undefined)
    }
    refreshPerformance()
    const timer = setInterval(refreshPerformance, 3000)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [refreshAgentCapabilities])

  const runUpdateCheck = async () => {
    setUpdateBusy(true)
    setUpdateResult(null)
    try {
      const result = await window.devterm.app.checkForUpdates()
      setUpdateResult(result)
      if (!appVersion && result.currentVersion) setAppVersion(result.currentVersion)
    } catch (e) {
      setUpdateResult({
        status: 'error',
        currentVersion: appVersion ?? 'unknown',
        message: (e as Error).message || String(e)
      })
    } finally {
      setUpdateBusy(false)
    }
  }

  const openChangelog = () => {
    void window.devterm.openExternal(CHANGELOG_URL)
  }

  const refreshRules = () => {
    window.devterm.approvalRules
      .list()
      .then(setRules)
      .catch(() => undefined)
  }

  useEffect(() => {
    refreshRules()
    const onFocus = () => refreshRules()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])

  const remoteSessions = useSessions(
    useShallow((s) => s.sessions.filter((x) => x.kind === 'remote'))
  )

  const addRule = async () => {
    const prefix = rulePrefix.trim()
    if (!prefix) {
      setRuleHint('Enter a command prefix first')
      return
    }
    const sessionId = ruleScope === 'session' ? ruleSessionId.trim() : undefined
    if (ruleScope === 'session' && !sessionId) {
      setRuleHint('Pick a session or switch scope to Global')
      return
    }
    setRuleBusy(true)
    setRuleHint(null)
    try {
      const next = await window.devterm.approvalRules.add({
        commandPrefix: prefix,
        outcome: ruleOutcome,
        sessionId
      })
      setRules(next)
      setRulePrefix('')
      setRuleHint(`Added ${ruleOutcome} rule for "${prefix}"`)
    } catch (e) {
      setRuleHint(`Add failed: ${(e as Error).message || String(e)}`)
    } finally {
      setRuleBusy(false)
    }
  }

  const removeRule = async (id: string) => {
    try {
      const next = await window.devterm.approvalRules.remove(id)
      setRules(next)
    } catch (e) {
      setRuleHint(`Remove failed: ${(e as Error).message || String(e)}`)
    }
  }

  useEffect(() => {
    if (!capturing) return
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        setCapturing(null)
        return
      }
      const combo = captureCombo(e)
      if (combo) setKeybinding(capturing, combo)
      setCapturing(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [capturing, setKeybinding])

  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setShellHint(`Copied: ${text}`)
      if (hintTimerRef.current) clearTimeout(hintTimerRef.current)
      hintTimerRef.current = setTimeout(() => {
        hintTimerRef.current = null
        setShellHint(null)
      }, 1800)
    } catch {
      setShellHint('Copy failed — select text manually')
      if (hintTimerRef.current) clearTimeout(hintTimerRef.current)
      hintTimerRef.current = setTimeout(() => {
        hintTimerRef.current = null
        setShellHint(null)
      }, 2500)
    }
  }

  const runShellPref = async (run: () => Promise<void>) => {
    setShellHint(null)
    setPwshBusy(true)
    try {
      await run()
    } finally {
      setPwshBusy(false)
    }
  }

  const pickTheme = (id: string) => {
    setThemeId(id)
    applyTheme(getTheme(id))
  }

  const chooseImage = async () => {
    setError(null)
    setBusy(true)
    try {
      const dataUrl = await window.devterm.dialog.chooseImage()
      if (dataUrl) setTerminalBg({ image: dataUrl })
    } catch (e) {
      setError((e as Error).message || 'Could not load image')
    } finally {
      setBusy(false)
    }
  }

  const runExport = async () => {
    setIoHint(null)
    try {
      const path = await window.devterm.settingsIo.export()
      setIoHint(path ? `Exported to ${path}` : 'Export cancelled')
    } catch (e) {
      setIoHint(`Export failed: ${(e as Error).message || String(e)}`)
    }
  }

  const runImport = async () => {
    setIoHint(null)
    try {
      const res = await window.devterm.settingsIo.import()
      if (res.ok && res.counts) {
        setIoHint(
          `Imported settings (${res.counts.snippets} snippets, ${res.counts.workspaces} workspaces)`
        )
      } else {
        setIoHint(`Import failed: ${res.error || 'unknown error'}`)
      }
    } catch (e) {
      setIoHint(`Import failed: ${(e as Error).message || String(e)}`)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal settings-modal-overhaul"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Left Sidebar Navigation */}
        <div className="settings-sidebar">
          <div className="settings-sidebar-header">
            <IconSettings size={18} />
            <h2 id="settings-modal-title">Settings</h2>
          </div>
          <nav className="settings-nav" aria-label="Settings categories">
            {NAV_GROUPS.map((group) => (
              <div className="settings-nav-group" key={group.label}>
                <div className="settings-nav-label">{group.label}</div>
                {group.tabs.map((tab) => {
                  const Icon = TAB_ICONS[tab]
                  const active = activeTab === tab
                  return (
                    <button
                      key={tab}
                      className={`settings-nav-item ${active ? 'active' : ''}`}
                      aria-current={active ? 'page' : undefined}
                      onClick={() => setActiveTab(tab)}
                    >
                      <Icon size={15} />
                      <span>{TAB_NAV_LABELS[tab]}</span>
                    </button>
                  )
                })}
              </div>
            ))}
          </nav>

          <div className="settings-sidebar-footer">
            <button
              className="ghost small"
              onClick={() => {
                reset()
                applyTheme(getTheme(useSettings.getState().themeId))
              }}
              title="Reset all settings to original factory defaults"
            >
              Reset defaults
            </button>
          </div>
        </div>

        {/* Right Main Content Pane */}
        <div className="settings-content-area">
          <div className="settings-content-header">
            <div className="settings-content-titles">
              <h3 className="settings-tab-title">{TAB_TITLES[activeTab]}</h3>
              <p className="settings-content-sub">{TAB_SUBTITLES[activeTab]}</p>
            </div>
            <button className="modal-x" onClick={onClose} title="Close Settings">
              <IconClose size={16} />
            </button>
          </div>

          <div className="settings-content-body">
            {/* 1. General & Shell */}
            {activeTab === 'general' && (
              <div className="settings-tab-pane">
                <div className="settings-card">
                  <div className="settings-card-header">
                    <h4>Default Local Shell</h4>
                    <p className="settings-card-subtitle">
                      Configures the initial shell process spawned for new local terminal panes.
                    </p>
                  </div>
                  <div className="settings-card-body">
                    <label className="settings-row-grid">
                      <span className="settings-label">Default shell</span>
                      <span className="settings-control">
                        <select
                          className="settings-select"
                          value={defaultShell.kind}
                          onChange={(e) => {
                            const k = e.target.value as DefaultShellPref['kind']
                            if (k === 'custom') {
                              setDefaultShell({
                                kind: 'custom',
                                path: defaultShell.kind === 'custom' ? defaultShell.path : ''
                              })
                            } else {
                              setDefaultShell({ kind: k } as DefaultShellPref)
                            }
                          }}
                        >
                          <option value="auto">Auto (recommended)</option>
                          <option value="pwsh">PowerShell 7 (pwsh.exe)</option>
                          <option value="powershell">Windows PowerShell 5.1</option>
                          <option value="cmd">Command Prompt (cmd.exe)</option>
                          <option value="custom">Custom path…</option>
                        </select>
                      </span>
                    </label>

                    {defaultShell.kind === 'custom' && (
                      <label className="settings-row-grid">
                        <span className="settings-label">Custom shell path</span>
                        <span className="settings-control">
                          <input
                            className="text-input"
                            type="text"
                            spellCheck={false}
                            placeholder="C:\Program Files\PowerShell\7\pwsh.exe"
                            value={defaultShell.path}
                            onChange={(e) =>
                              setDefaultShell({ kind: 'custom', path: e.target.value })
                            }
                          />
                        </span>
                      </label>
                    )}

                    {window.devterm.platform === 'win32' && (
                      <div className="settings-row-grid">
                        <span className="settings-label">PowerShell 7 quick fix</span>
                        <span className="settings-control">
                          <button
                            className="ghost small"
                            disabled={pwshBusy}
                            title="Copy winget install command for PowerShell 7"
                            onClick={() =>
                              runShellPref(async () => {
                                await copyText('winget install Microsoft.PowerShell')
                              })
                            }
                          >
                            Copy winget command
                          </button>
                          {shellHint && <span className="settings-hint">{shellHint}</span>}
                        </span>
                      </div>
                    )}
                  </div>
                </div>

                <div className="settings-card">
                  <div className="settings-card-header">
                    <h4>SSH Connections &amp; Workspaces</h4>
                    <p className="settings-card-subtitle">
                      Automatic recovery policies for transport disconnects.
                    </p>
                  </div>
                  <div className="settings-card-body">
                    <label className="settings-row-grid">
                      <span className="settings-label">Auto-reconnect SSH sessions</span>
                      <span className="settings-control">
                        <input
                          type="checkbox"
                          checked={autoReconnect.enabled}
                          onChange={(e) => setAutoReconnect({ enabled: e.target.checked })}
                        />
                      </span>
                    </label>

                    <label className="settings-row-grid">
                      <span className="settings-label">Max reconnect attempts</span>
                      <span className="settings-control">
                        <input
                          type="range"
                          min={1}
                          max={20}
                          step={1}
                          value={autoReconnect.maxAttempts}
                          disabled={!autoReconnect.enabled}
                          onChange={(e) =>
                            setAutoReconnect({ maxAttempts: Number(e.target.value) })
                          }
                        />
                        <span className="settings-val-badge">{autoReconnect.maxAttempts}</span>
                      </span>
                    </label>

                    <label className="settings-row-grid">
                      <span className="settings-label">
                        Zen mode (
                        {comboLabel(
                          HOTKEYS.find((h) => h.id === 'toggleZenMode')!,
                          window.devterm.platform === 'darwin'
                        )}
                        )
                      </span>
                      <span className="settings-control">
                        <input
                          type="checkbox"
                          checked={zenMode}
                          onChange={(e) => setZenMode(e.target.checked)}
                        />
                      </span>
                    </label>
                  </div>
                </div>
              </div>
            )}

            {/* 2. Appearance & Themes */}
            {activeTab === 'appearance' && (
              <div className="settings-tab-pane">
                <div className="settings-card">
                  <div className="settings-card-header">
                    <h4>Color Theme</h4>
                    <p className="settings-card-subtitle">
                      Theme drives the terminal ANSI palette and full application chrome.
                    </p>
                  </div>
                  <div className="settings-card-body">
                    <div className="theme-grid">
                      {THEMES.map((t) => (
                        <ThemeSwatch
                          key={t.id}
                          theme={t}
                          active={t.id === themeId}
                          onPick={() => pickTheme(t.id)}
                        />
                      ))}
                    </div>
                  </div>
                </div>

                <div className="settings-card">
                  <div className="settings-card-header">
                    <h4>Background Image &amp; Bell</h4>
                    <p className="settings-card-subtitle">
                      Custom background image overlay and terminal visual alerts.
                    </p>
                  </div>
                  <div className="settings-card-body">
                    <label className="settings-row-grid">
                      <span className="settings-label">Terminal visual bell</span>
                      <span className="settings-control">
                        <select
                          className="settings-select"
                          value={prefs.bell}
                          onChange={(e) => setPrefs({ bell: e.target.value as typeof prefs.bell })}
                        >
                          <option value="none">None (silent)</option>
                          <option value="visual">Visual flash</option>
                        </select>
                      </span>
                    </label>

                    <div className="settings-row-grid">
                      <span className="settings-label">Background image</span>
                      <span className="settings-control">
                        <button className="primary small" disabled={busy} onClick={chooseImage}>
                          {busy ? 'Loading…' : terminalBg.image ? 'Change image…' : 'Choose image…'}
                        </button>
                        {terminalBg.image && (
                          <button
                            className="danger small"
                            onClick={() => setTerminalBg({ image: null })}
                          >
                            Remove
                          </button>
                        )}
                      </span>
                    </div>
                    {error && <div className="settings-error">{error}</div>}

                    {terminalBg.image && (
                      <>
                        <div
                          className="settings-bg-preview"
                          style={{
                            backgroundColor: getTheme(themeId).terminal.background,
                            backgroundImage: `linear-gradient(rgba(0,0,0,${terminalBg.dim}),rgba(0,0,0,${terminalBg.dim})), url("${terminalBg.image}")`
                          }}
                        >
                          <span>Preview</span>
                        </div>
                        <label className="settings-row-grid">
                          <span className="settings-label">
                            Image dim ({Math.round(terminalBg.dim * 100)}%)
                          </span>
                          <span className="settings-control">
                            <input
                              type="range"
                              min={0}
                              max={0.85}
                              step={0.05}
                              value={terminalBg.dim}
                              onChange={(e) => setTerminalBg({ dim: Number(e.target.value) })}
                            />
                          </span>
                        </label>
                      </>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* 3. Terminal & Font */}
            {activeTab === 'terminal' && (
              <div className="settings-tab-pane">
                <div className="settings-card">
                  <div className="settings-card-header">
                    <h4>Typography &amp; Text</h4>
                    <p className="settings-card-subtitle">
                      Font metrics applied to xterm rendering engine.
                    </p>
                  </div>
                  <div className="settings-card-body">
                    <label className="settings-row-grid">
                      <span className="settings-label">Font family</span>
                      <span className="settings-control">
                        <select
                          className="settings-select"
                          value={FONT_PRESETS.includes(prefs.fontFamily) ? prefs.fontFamily : ''}
                          onChange={(e) =>
                            e.target.value && setPrefs({ fontFamily: e.target.value })
                          }
                        >
                          {!FONT_PRESETS.includes(prefs.fontFamily) && (
                            <option value="">(custom)</option>
                          )}
                          {FONT_PRESETS.map((f) => (
                            <option key={f} value={f}>
                              {f.split(',')[0]}
                            </option>
                          ))}
                        </select>
                      </span>
                    </label>

                    <label className="settings-row-grid">
                      <span className="settings-label">Font size</span>
                      <span className="settings-control">
                        <input
                          type="range"
                          min={8}
                          max={32}
                          step={1}
                          value={prefs.fontSize}
                          onChange={(e) => setPrefs({ fontSize: Number(e.target.value) })}
                        />
                        <span className="settings-val-badge">{prefs.fontSize}px</span>
                      </span>
                    </label>

                    <label className="settings-row-grid">
                      <span className="settings-label">Line height</span>
                      <span className="settings-control">
                        <input
                          type="range"
                          min={1}
                          max={2}
                          step={0.05}
                          value={prefs.lineHeight}
                          onChange={(e) => setPrefs({ lineHeight: Number(e.target.value) })}
                        />
                        <span className="settings-val-badge">{prefs.lineHeight.toFixed(2)}</span>
                      </span>
                    </label>
                  </div>
                </div>

                <div className="settings-card">
                  <div className="settings-card-header">
                    <h4>Cursor &amp; Interaction</h4>
                    <p className="settings-card-subtitle">
                      Clipboard, cursor shape, and buffer options.
                    </p>
                  </div>
                  <div className="settings-card-body">
                    <label className="settings-row-grid">
                      <span className="settings-label">Cursor style</span>
                      <span className="settings-control">
                        <select
                          className="settings-select"
                          value={prefs.cursorStyle}
                          onChange={(e) =>
                            setPrefs({ cursorStyle: e.target.value as typeof prefs.cursorStyle })
                          }
                        >
                          <option value="block">Block</option>
                          <option value="bar">Bar</option>
                          <option value="underline">Underline</option>
                        </select>
                      </span>
                    </label>

                    <label className="settings-row-grid">
                      <span className="settings-label">Cursor blinking</span>
                      <span className="settings-control">
                        <input
                          type="checkbox"
                          checked={prefs.cursorBlink}
                          onChange={(e) => setPrefs({ cursorBlink: e.target.checked })}
                        />
                      </span>
                    </label>

                    <label className="settings-row-grid">
                      <span className="settings-label">Copy text on selection</span>
                      <span className="settings-control">
                        <input
                          type="checkbox"
                          checked={prefs.copyOnSelect}
                          onChange={(e) => setPrefs({ copyOnSelect: e.target.checked })}
                        />
                      </span>
                    </label>

                    <label className="settings-row-grid">
                      <span className="settings-label">Right-click pastes clipboard</span>
                      <span className="settings-control">
                        <input
                          type="checkbox"
                          checked={prefs.rightClickPaste}
                          onChange={(e) => setPrefs({ rightClickPaste: e.target.checked })}
                        />
                      </span>
                    </label>

                    <label className="settings-row-grid">
                      <span className="settings-label">Scrollback buffer limit</span>
                      <span className="settings-control">
                        <input
                          className="text-input num-input"
                          type="number"
                          min={100}
                          max={100000}
                          step={500}
                          value={prefs.scrollback}
                          onChange={(e) =>
                            setPrefs({
                              scrollback: clamp(Number(e.target.value) || 10000, 100, 100000)
                            })
                          }
                        />
                        <span className="settings-hint">lines</span>
                      </span>
                    </label>
                  </div>
                </div>
              </div>
            )}

            {/* 4. Layout & Panes */}
            {activeTab === 'layout' && (
              <div className="settings-tab-pane">
                <div className="settings-card">
                  <div className="settings-card-header">
                    <h4>Pane Rendering &amp; Side Panels</h4>
                    <p className="settings-card-subtitle">
                      Controls visual focus and auxiliary panels.
                    </p>
                  </div>
                  <div className="settings-card-body">
                    <label className="settings-row-grid">
                      <span className="settings-label">Dim inactive split panes</span>
                      <span className="settings-control">
                        <input
                          type="checkbox"
                          checked={inactivePaneDimming}
                          onChange={(e) => setInactivePaneDimming(e.target.checked)}
                        />
                      </span>
                    </label>

                    <label className="settings-row-grid">
                      <span className="settings-label">SFTP side panel on remote tabs</span>
                      <span className="settings-control">
                        <input
                          type="checkbox"
                          checked={sftpSidePane}
                          onChange={(e) => setSftpSidePane(e.target.checked)}
                        />
                      </span>
                    </label>

                    <label className="settings-row-grid">
                      <span className="settings-label">Show tab activity indicators</span>
                      <span className="settings-control">
                        <input
                          type="checkbox"
                          checked={activityIndicators}
                          onChange={(e) => setActivityIndicators(e.target.checked)}
                        />
                      </span>
                    </label>

                    <label className="settings-row-grid">
                      <span className="settings-label">Offer tmux sessions on connect</span>
                      <span className="settings-control">
                        <input
                          type="checkbox"
                          checked={remoteDetachedSessions}
                          onChange={(e) => setRemoteDetachedSessions(e.target.checked)}
                        />
                      </span>
                    </label>
                    <p className="settings-hint">
                      When a POSIX remote has a working tmux, pick an existing session, start a new
                      one, or use a normal shell. Detaching from tmux returns you to that shell
                      instead of closing the connection.
                    </p>

                    <label className="settings-row-grid">
                      <span className="settings-label">Restore last session on startup</span>
                      <span className="settings-control">
                        <input
                          type="checkbox"
                          checked={sessionRestore}
                          onChange={(e) => setSessionRestore(e.target.checked)}
                        />
                      </span>
                    </label>
                    <p className="settings-hint">
                      Reopens local shells and saved SSH connections with their split layout.
                      Workspace auto-launch still takes priority when enabled. Ad-hoc SSH (not
                      saved) is skipped.
                    </p>
                  </div>
                </div>

                <div className="settings-card">
                  <div className="settings-card-header">
                    <h4>Attention &amp; Notifications</h4>
                    <p className="settings-card-subtitle">
                      Alerts when background agent commands finish.
                    </p>
                  </div>
                  <div className="settings-card-body">
                    <label className="settings-row-grid">
                      <span className="settings-label">Enable attention alerts</span>
                      <span className="settings-control">
                        <input
                          type="checkbox"
                          checked={attention.enabled}
                          onChange={(e) => setAttention({ enabled: e.target.checked })}
                        />
                      </span>
                    </label>

                    <label className="settings-row-grid">
                      <span className="settings-label">Audio chime</span>
                      <span className="settings-control">
                        <input
                          type="checkbox"
                          checked={attention.sound}
                          disabled={!attention.enabled}
                          onChange={(e) => setAttention({ sound: e.target.checked })}
                        />
                        <button
                          className="ghost small"
                          disabled={!attention.enabled || !attention.sound}
                          onClick={() => chime(attention.volume)}
                        >
                          Test sound
                        </button>
                      </span>
                    </label>

                    <label className="settings-row-grid">
                      <span className="settings-label">Chime volume</span>
                      <span className="settings-control">
                        <input
                          type="range"
                          min={0}
                          max={1}
                          step={0.05}
                          value={attention.volume}
                          disabled={!attention.enabled || !attention.sound}
                          onChange={(e) => setAttention({ volume: Number(e.target.value) })}
                        />
                        <span className="settings-val-badge">
                          {Math.round(attention.volume * 100)}%
                        </span>
                      </span>
                    </label>

                    <label className="settings-row-grid">
                      <span className="settings-label">OS notification + taskbar flash</span>
                      <span className="settings-control">
                        <input
                          type="checkbox"
                          checked={attention.system}
                          disabled={!attention.enabled}
                          onChange={(e) => setAttention({ system: e.target.checked })}
                        />
                      </span>
                    </label>
                  </div>
                </div>
              </div>
            )}

            {/* 5. DevTerm Agent & Guardrails */}
            {activeTab === 'agent' && (
              <div className="settings-tab-pane">
                <div className="settings-card">
                  <div className="settings-card-header">
                    <h4>DevTerm Agent Settings</h4>
                    <p className="settings-card-subtitle">
                      Configures default provider, model routing, and automatic failovers.
                    </p>
                  </div>
                  <div className="settings-card-body">
                    <label className="settings-row-grid">
                      <span className="settings-label">Provider</span>
                      <span className="settings-control">
                        <select
                          className="settings-select"
                          value={agentPreferences.provider}
                          onChange={(e) =>
                            setAgentPreferences({ provider: e.target.value, model: '' })
                          }
                        >
                          <option value="">Automatic (default)</option>
                          {agentCapabilities?.providers.map((provider) => (
                            <option key={provider.provider} value={provider.provider}>
                              {provider.provider}
                              {provider.authenticated ? ` — connected (${provider.source})` : ''}
                            </option>
                          ))}
                        </select>
                      </span>
                    </label>

                    <label className="settings-row-grid">
                      <span className="settings-label">Model</span>
                      <span className="settings-control">
                        <input
                          className="text-input"
                          list="devterm-agent-models"
                          value={agentPreferences.model}
                          placeholder="Provider default"
                          onChange={(e) => setAgentPreferences({ model: e.target.value })}
                        />
                        <datalist id="devterm-agent-models">
                          {agentCapabilities?.models
                            .filter(
                              (model) =>
                                !agentPreferences.provider ||
                                model.provider === agentPreferences.provider
                            )
                            .slice(0, 500)
                            .map((model) => (
                              <option
                                key={`${model.provider}/${model.model}`}
                                value={`${model.provider}/${model.model}`}
                              >
                                {model.context} context{model.thinking ? ' · thinking' : ''}
                              </option>
                            ))}
                        </datalist>
                      </span>
                    </label>

                    <label className="settings-row-grid">
                      <span className="settings-label">Fallback models</span>
                      <span className="settings-control">
                        <input
                          className="text-input"
                          value={fallbackDraft}
                          placeholder="anthropic/claude-sonnet-4.6, openai/gpt-5"
                          onChange={(e) => setFallbackDraft(e.target.value)}
                          onBlur={() =>
                            setAgentPreferences({
                              fallbackModels: fallbackDraft
                                .split(',')
                                .map((value) => value.trim())
                                .filter((value) => value.includes('/'))
                            })
                          }
                        />
                      </span>
                    </label>

                    <label className="settings-row-grid">
                      <span className="settings-label">Resume conversations</span>
                      <span className="settings-control">
                        <input
                          type="checkbox"
                          checked={agentPreferences.resumeSessions}
                          onChange={(e) =>
                            setAgentPreferences({ resumeSessions: e.target.checked })
                          }
                        />
                      </span>
                    </label>

                    <label
                      className="settings-row-grid"
                      title="Let the agent open and drive in-app browser tabs. Its own tabs are free; your tabs require a one-time confirmation per tab."
                    >
                      <span className="settings-label">Browser tools</span>
                      <span className="settings-control">
                        <input
                          type="checkbox"
                          checked={agentPreferences.browserTools}
                          onChange={(e) => setAgentPreferences({ browserTools: e.target.checked })}
                        />
                      </span>
                    </label>

                    <label
                      className="settings-row-grid"
                      title="Allow local agents to open visible sibling agent tabs and send follow-up messages."
                    >
                      <span className="settings-label">Local agent handoff</span>
                      <span className="settings-control">
                        <input
                          type="checkbox"
                          checked={agentPreferences.agentHandoff}
                          onChange={(e) => setAgentPreferences({ agentHandoff: e.target.checked })}
                        />
                      </span>
                    </label>

                    <div className="settings-row-grid">
                      <span className="settings-label">Trusted skills</span>
                      <span className="settings-control">
                        <button className="ghost small" onClick={() => void addTrustedSkill()}>
                          Add skill file…
                        </button>
                      </span>
                    </div>

                    {agentPreferences.trustedSkills.map((skill) => (
                      <div className="settings-row-grid" key={skill.path}>
                        <span className="settings-label" title={skill.path}>
                          {skill.name}
                        </span>
                        <span className="settings-control">
                          <input
                            type="checkbox"
                            checked={skill.enabled}
                            onChange={(e) =>
                              setAgentPreferences({
                                trustedSkills: agentPreferences.trustedSkills.map((item) =>
                                  item.path === skill.path
                                    ? { ...item, enabled: e.target.checked }
                                    : item
                                )
                              })
                            }
                          />
                          <code>{skill.sha256.slice(0, 12)}…</code>
                          <button
                            className="ghost small"
                            onClick={() =>
                              setAgentPreferences({
                                trustedSkills: agentPreferences.trustedSkills.filter(
                                  (item) => item.path !== skill.path
                                )
                              })
                            }
                          >
                            Remove
                          </button>
                        </span>
                      </div>
                    ))}
                    <div className="settings-row-grid">
                      <span className="settings-label">Runtime catalog</span>
                      <span className="settings-control">
                        <button
                          className="ghost small"
                          disabled={agentCapabilitiesBusy}
                          onClick={() => void refreshAgentCapabilities(true)}
                        >
                          {agentCapabilitiesBusy ? 'Loading…' : 'Refresh catalog'}
                        </button>
                        {agentCapabilities && (
                          <span className="settings-hint">
                            v{agentCapabilities.runtimeVersion} · {agentCapabilities.models.length}{' '}
                            models
                          </span>
                        )}
                      </span>
                    </div>
                    {agentCapabilitiesError && (
                      <div className="settings-error">Catalog error: {agentCapabilitiesError}</div>
                    )}
                  </div>
                </div>

                <div className="settings-card">
                  <div className="settings-card-header">
                    <h4>Approval Guardrails</h4>
                    <p className="settings-card-subtitle">
                      Hard allow / deny / ask rules for MCP tools on the host.
                    </p>
                  </div>
                  <div className="settings-card-body">
                    <div className="rule-form">
                      <div className="rule-inputs-row">
                        <input
                          type="text"
                          className="text-input"
                          value={rulePrefix}
                          placeholder="Command prefix (e.g. git commit)"
                          onChange={(e) => setRulePrefix(e.target.value)}
                        />
                        <select
                          className="settings-select"
                          value={ruleOutcome}
                          onChange={(e) =>
                            setRuleOutcome(e.target.value as ApprovalRule['outcome'])
                          }
                        >
                          <option value="allow">Allow (skip confirm)</option>
                          <option value="deny">Deny (always block)</option>
                          <option value="ask">Ask (always prompt)</option>
                        </select>
                        <select
                          className="settings-select"
                          value={ruleScope}
                          onChange={(e) => setRuleScope(e.target.value as 'global' | 'session')}
                        >
                          <option value="global">Global</option>
                          <option value="session">Per session</option>
                        </select>
                        {ruleScope === 'session' && (
                          <select
                            className="settings-select"
                            value={ruleSessionId}
                            onChange={(e) => setRuleSessionId(e.target.value)}
                          >
                            <option value="" disabled>
                              Pick session…
                            </option>
                            {remoteSessions.map((s) => (
                              <option key={s.id} value={s.id}>
                                {s.context?.hostname || s.title || s.id}
                              </option>
                            ))}
                          </select>
                        )}
                        <button
                          className="primary small"
                          disabled={ruleBusy || !rulePrefix.trim()}
                          onClick={() => void addRule()}
                        >
                          {ruleBusy ? 'Adding…' : 'Add rule'}
                        </button>
                      </div>
                      {ruleHint && <div className="settings-hint">{ruleHint}</div>}
                    </div>

                    {rules.length === 0 ? (
                      <div className="settings-empty">No custom approval rules defined.</div>
                    ) : (
                      <ul className="rule-list">
                        {rules.map((r) => (
                          <li key={r.id} className="rule-row">
                            <span className={`rule-outcome rule-outcome-${r.outcome}`}>
                              {r.outcome}
                            </span>
                            <code className="rule-prefix">{r.commandPrefix}</code>
                            <span className="rule-scope">
                              {r.sessionId ? `session: ${r.sessionId.slice(0, 8)}…` : 'global'}
                            </span>
                            <button className="ghost small" onClick={() => void removeRule(r.id)}>
                              Delete
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* 6. Keybindings */}
            {activeTab === 'hotkeys' && (
              <div className="settings-tab-pane">
                <div className="settings-card">
                  <div className="settings-card-header">
                    <h4>Global Shortcuts</h4>
                    <p className="settings-card-subtitle">
                      Click Edit next to any hotkey to record a custom key combination.
                    </p>
                  </div>
                  <div className="settings-card-body">
                    <div className="kb-list">
                      {HOTKEYS.filter((h) => !h.alias).map((h) => {
                        const custom = keybindings[h.id]
                        const combo = custom ?? {
                          mod: h.mod,
                          shift: h.shift,
                          alt: h.alt,
                          key: h.key
                        }
                        const isCapturing = capturing === h.id
                        return (
                          <div key={h.id} className="kb-row">
                            <span className="kb-label">{h.label}</span>
                            <span className={`kb-combo ${custom ? 'is-custom' : ''}`}>
                              {isCapturing
                                ? 'Press new shortcut…'
                                : comboLabel(
                                    { ...h, ...combo },
                                    window.devterm.platform === 'darwin'
                                  )}
                            </span>
                            <span className="kb-actions">
                              <button
                                type="button"
                                className="ghost small"
                                onClick={() => setCapturing(h.id)}
                                disabled={isCapturing}
                              >
                                Edit
                              </button>
                              {custom ? (
                                <button
                                  type="button"
                                  className="ghost small"
                                  onClick={() => setKeybinding(h.id, null)}
                                >
                                  Reset
                                </button>
                              ) : (
                                <span className="kb-actions-spacer" aria-hidden="true" />
                              )}
                            </span>
                          </div>
                        )
                      })}
                    </div>
                    {capturing && (
                      <div className="kb-capture-overlay" onClick={() => setCapturing(null)}>
                        <div className="kb-capture-box">
                          Press shortcut for {HOTKEYS.find((h) => h.id === capturing)?.label}
                        </div>
                      </div>
                    )}
                    <div className="settings-row-grid" style={{ marginTop: 12 }}>
                      <span className="settings-label" />
                      <span className="settings-control">
                        <button className="ghost small" onClick={resetKeybindings}>
                          Reset all keybindings
                        </button>
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* 7. Voice Dictation */}
            {activeTab === 'dictation' && (
              <div className="settings-tab-pane">
                <div className="settings-card">
                  <div className="settings-card-header">
                    <h4>Local Offline Dictation (Whisper)</h4>
                    <p className="settings-card-subtitle">
                      Transcribes speech locally via WebGPU/WASM. No audio leaves your machine.
                    </p>
                  </div>
                  <div className="settings-card-body">
                    <label className="settings-row-grid">
                      <span className="settings-label">Enable voice dictation</span>
                      <span className="settings-control">
                        <input
                          type="checkbox"
                          checked={stt.enabled}
                          onChange={(e) => setStt({ enabled: e.target.checked })}
                        />
                      </span>
                    </label>

                    <label className="settings-row-grid">
                      <span className="settings-label">Speech model</span>
                      <span className="settings-control">
                        <select
                          className="settings-select"
                          value={stt.modelId}
                          disabled={!stt.enabled}
                          onChange={(e) =>
                            setStt({ modelId: e.target.value as typeof stt.modelId })
                          }
                        >
                          <option value="tiny">Tiny — fastest (~75 MB)</option>
                          <option value="base">Base — balanced (~140 MB, recommended)</option>
                          <option value="small">Small — highest accuracy (~470 MB)</option>
                        </select>
                      </span>
                    </label>

                    <label className="settings-row-grid">
                      <span className="settings-label">Language</span>
                      <span className="settings-control">
                        <select
                          className="settings-select"
                          value={stt.language}
                          disabled={!stt.enabled}
                          onChange={(e) =>
                            setStt({ language: e.target.value as typeof stt.language })
                          }
                        >
                          <option value="auto">Auto-detect</option>
                          <option value="en">English</option>
                          <option value="es">Spanish</option>
                          <option value="fr">French</option>
                          <option value="de">German</option>
                          <option value="it">Italian</option>
                          <option value="pt">Portuguese</option>
                          <option value="nl">Dutch</option>
                          <option value="ru">Russian</option>
                          <option value="zh">Chinese</option>
                          <option value="ja">Japanese</option>
                          <option value="ko">Korean</option>
                        </select>
                      </span>
                    </label>

                    <label className="settings-row-grid">
                      <span className="settings-label">Append trailing space</span>
                      <span className="settings-control">
                        <input
                          type="checkbox"
                          checked={stt.appendSpace}
                          disabled={!stt.enabled}
                          onChange={(e) => setStt({ appendSpace: e.target.checked })}
                        />
                      </span>
                    </label>

                    <label className="settings-row-grid">
                      <span className="settings-label">Floating status pill</span>
                      <span className="settings-control">
                        <input
                          type="checkbox"
                          checked={stt.showFloatingStatus}
                          disabled={!stt.enabled}
                          onChange={(e) => setStt({ showFloatingStatus: e.target.checked })}
                        />
                      </span>
                    </label>

                    <div className="settings-row-grid">
                      <span className="settings-label">Model cache</span>
                      <span className="settings-control">
                        <button
                          className="ghost small"
                          onClick={async () => {
                            try {
                              const keys = await caches.keys()
                              const targets = keys.filter((k) => /transformers|onnx|hf/i.test(k))
                              await Promise.all(targets.map((k) => caches.delete(k)))
                              setSttHint(
                                targets.length
                                  ? `Cleared ${targets.length} cached model stores.`
                                  : 'No cached model found.'
                              )
                            } catch (err) {
                              setSttHint(
                                err instanceof Error ? err.message : 'Could not clear cache.'
                              )
                            }
                          }}
                        >
                          Clear cached speech model
                        </button>
                      </span>
                    </div>
                    {sttHint && <div className="settings-hint">{sttHint}</div>}
                  </div>
                </div>
              </div>
            )}

            {/* 8. System & Backup */}
            {activeTab === 'system' && (
              <div className="settings-tab-pane">
                <div className="settings-card">
                  <div className="settings-card-header">
                    <h4>About &amp; Updates</h4>
                    <p className="settings-card-subtitle">
                      Current version, manual update check, and release notes on GitHub.
                    </p>
                  </div>
                  <div className="settings-card-body">
                    <div className="settings-row-grid">
                      <span className="settings-label">Version</span>
                      <span className="settings-control">
                        <code className="settings-version-badge">
                          {appVersion ? `v${appVersion}` : '…'}
                        </code>
                      </span>
                    </div>
                    <div className="settings-row-grid">
                      <span className="settings-label">Updates</span>
                      <span className="settings-control">
                        <button
                          className="ghost small"
                          type="button"
                          disabled={updateBusy}
                          onClick={() => void runUpdateCheck()}
                        >
                          {updateBusy ? 'Checking…' : 'Check for updates'}
                        </button>
                        <button className="ghost small" type="button" onClick={openChangelog}>
                          Changelog
                        </button>
                      </span>
                    </div>
                    {updateResult && (
                      <div
                        className={`settings-hint update-status update-status-${updateResult.status}`}
                        role="status"
                      >
                        {updateResult.message}
                        {updateResult.latestVersion &&
                          updateResult.status !== 'up-to-date' &&
                          updateResult.latestVersion !== updateResult.currentVersion && (
                            <> (latest: v{updateResult.latestVersion})</>
                          )}
                      </div>
                    )}
                  </div>
                </div>

                <div className="settings-card">
                  <div className="settings-card-header">
                    <h4>Search &amp; Telemetry</h4>
                    <p className="settings-card-subtitle">
                      Local terminal search indexing and real-time process monitoring.
                    </p>
                  </div>
                  <div className="settings-card-body">
                    <label className="settings-row-grid">
                      <span className="settings-label">Persist search history (5000 lines)</span>
                      <span className="settings-control">
                        <input
                          type="checkbox"
                          checked={searchPersist}
                          onChange={(e) => setSearchPersist(e.target.checked)}
                        />
                      </span>
                    </label>

                    {performance ? (
                      <div className="perf-telemetry-box">
                        <div className="perf-metric">
                          <strong>Uptime:</strong> {(performance.uptimeMs / 1000).toFixed(1)}s
                        </div>
                        <div className="perf-metric">
                          <strong>Main Heap:</strong> {performance.mainHeapUsedMb.toFixed(1)} MB /{' '}
                          {performance.mainHeapTotalMb.toFixed(1)} MB
                        </div>
                        <div className="perf-procs">
                          {performance.processes
                            .slice()
                            .sort((a, b) => b.cpuPercent - a.cpuPercent)
                            .slice(0, 6)
                            .map((p) => (
                              <div className="perf-proc-row" key={p.pid}>
                                <span className="p-type">{p.type}</span>
                                <span className="p-stats">
                                  {p.cpuPercent.toFixed(1)}% CPU · {p.workingSetMb.toFixed(1)} MB
                                </span>
                              </div>
                            ))}
                        </div>
                      </div>
                    ) : (
                      <div className="settings-empty">Collecting local telemetry snapshot…</div>
                    )}
                  </div>
                </div>

                <div className="settings-card">
                  <div className="settings-card-header">
                    <h4>Backup &amp; Restore</h4>
                    <p className="settings-card-subtitle">Export or restore settings JSON files.</p>
                  </div>
                  <div className="settings-card-body">
                    <div className="settings-row-grid">
                      <span className="settings-label">Settings JSON</span>
                      <span className="settings-control">
                        <button className="ghost small" onClick={() => void runExport()}>
                          Export backup…
                        </button>
                        <button className="ghost small" onClick={() => void runImport()}>
                          Import backup…
                        </button>
                      </span>
                    </div>
                    {ioHint && <div className="settings-hint">{ioHint}</div>}
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="settings-content-footer">
            {appVersion && (
              <span className="settings-footer-version" title="Installed DevTerm version">
                DevTerm v{appVersion}
              </span>
            )}
            <button className="ghost" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
