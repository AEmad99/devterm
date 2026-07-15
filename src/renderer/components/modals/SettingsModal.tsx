import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { useSettings } from '../../store/settings'
import { useSessions } from '../../store/sessions'
import type { ApprovalRule, DefaultShellPref } from '@shared/types'
import { THEMES, getTheme, applyTheme, type Theme } from '../../lib/themes'
import { HOTKEYS, comboLabel, captureCombo, type HotkeyId } from '../../lib/hotkeys'
import { chime } from '../../lib/attention'
import { IconClose } from '../common/Icons'

const FONT_PRESETS = [
  'Cascadia Code, Consolas, "Courier New", monospace',
  'Consolas, monospace',
  'JetBrains Mono, monospace',
  'Fira Code, monospace',
  'Menlo, Monaco, monospace',
  'Courier New, monospace'
]

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))

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
 * Settings — appearance theme, terminal text/cursor, behavior, and an optional
 * background image. Theme drives both the terminal ANSI palette and the whole app
 * chrome; all changes apply live to every open terminal and persist.
 */
export default function SettingsModal({ onClose }: { onClose: () => void }) {
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
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [shellHint, setShellHint] = useState<string | null>(null)
  const [pwshBusy, setPwshBusy] = useState(false)
  const [ioHint, setIoHint] = useState<string | null>(null)
  const [capturing, setCapturing] = useState<HotkeyId | null>(null)
  const [sttHint, setSttHint] = useState<string | null>(null)
  // Agent guardrails (approval rules) — list + add/remove UI.
  const [rules, setRules] = useState<ApprovalRule[]>([])
  const [rulePrefix, setRulePrefix] = useState('')
  const [ruleOutcome, setRuleOutcome] = useState<ApprovalRule['outcome']>('allow')
  const [ruleScope, setRuleScope] = useState<'global' | 'session'>('global')
  const [ruleSessionId, setRuleSessionId] = useState('')
  const [ruleBusy, setRuleBusy] = useState(false)
  const [ruleHint, setRuleHint] = useState<string | null>(null)
  const hintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (hintTimerRef.current) {
        clearTimeout(hintTimerRef.current)
        hintTimerRef.current = null
      }
    }
  }, [])

  // Load agent approval rules when the modal opens; refresh on focus so a
  // rule added via the "Remember my choice" checkbox in ConfirmActionModal
  // shows up here without a manual reload.
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

  const remoteSessions = useSessions((s) => s.sessions.filter((x) => x.kind === 'remote'))

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
      setRuleHint(`Added ${ruleOutcome} rule for “${prefix}”`)
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
      setShellHint('Copy failed — select the text manually')
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
          `Imported settings, ${res.counts.snippets} snippets, ${res.counts.workspaces} workspaces`
        )
      } else {
        setIoHint(`Import failed: ${res.error || 'unknown error'}`)
      }
    } catch (e) {
      setIoHint(`Import failed: ${(e as Error).message || String(e)}`)
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal settings-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Settings</h2>
          <button className="modal-x" onClick={onClose} title="Close">
            <IconClose size={16} />
          </button>
        </div>

        <section className="settings-section">
          <h3>Theme</h3>
          <div className="settings-sub-hint">
            Sets the terminal palette and the whole app — pick the look you like.
          </div>
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
        </section>

        <section className="settings-section">
          <h3>Text &amp; cursor</h3>

          <label className="settings-row">
            <span className="settings-label">Font size ({prefs.fontSize}px)</span>
            <span className="settings-control">
              <input
                type="range"
                min={8}
                max={32}
                step={1}
                value={prefs.fontSize}
                onChange={(e) => setPrefs({ fontSize: Number(e.target.value) })}
              />
            </span>
          </label>

          <label className="settings-row">
            <span className="settings-label">Font family</span>
            <span className="settings-control">
              <select
                className="settings-select"
                value={FONT_PRESETS.includes(prefs.fontFamily) ? prefs.fontFamily : ''}
                onChange={(e) => e.target.value && setPrefs({ fontFamily: e.target.value })}
              >
                {!FONT_PRESETS.includes(prefs.fontFamily) && <option value="">(custom)</option>}
                {FONT_PRESETS.map((f) => (
                  <option key={f} value={f}>
                    {f.split(',')[0]}
                  </option>
                ))}
              </select>
            </span>
          </label>

          <label className="settings-row">
            <span className="settings-label">Line height ({prefs.lineHeight.toFixed(2)})</span>
            <span className="settings-control">
              <input
                type="range"
                min={1}
                max={2}
                step={0.05}
                value={prefs.lineHeight}
                onChange={(e) => setPrefs({ lineHeight: Number(e.target.value) })}
              />
            </span>
          </label>

          <label className="settings-row">
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

          <label className="settings-row">
            <span className="settings-label">Cursor blink</span>
            <span className="settings-control">
              <input
                type="checkbox"
                checked={prefs.cursorBlink}
                onChange={(e) => setPrefs({ cursorBlink: e.target.checked })}
              />
            </span>
          </label>

          <label className="settings-row">
            <span className="settings-label">Scrollback (lines)</span>
            <span className="settings-control">
              <input
                className="settings-hex"
                type="number"
                min={100}
                max={100000}
                step={100}
                value={prefs.scrollback}
                onChange={(e) =>
                  setPrefs({ scrollback: clamp(Number(e.target.value) || 1000, 100, 100000) })
                }
              />
            </span>
          </label>
        </section>

        <section className="settings-section">
          <h3>Behavior</h3>

          <label className="settings-row">
            <span className="settings-label">Copy on select</span>
            <span className="settings-control">
              <input
                type="checkbox"
                checked={prefs.copyOnSelect}
                onChange={(e) => setPrefs({ copyOnSelect: e.target.checked })}
              />
            </span>
          </label>

          <label className="settings-row">
            <span className="settings-label">Right-click pastes</span>
            <span className="settings-control">
              <input
                type="checkbox"
                checked={prefs.rightClickPaste}
                onChange={(e) => setPrefs({ rightClickPaste: e.target.checked })}
              />
            </span>
          </label>

          <label className="settings-row">
            <span className="settings-label">Scroll speed ({prefs.scrollSensitivity}×)</span>
            <span className="settings-control">
              <input
                type="range"
                min={1}
                max={10}
                step={1}
                value={prefs.scrollSensitivity}
                onChange={(e) => setPrefs({ scrollSensitivity: Number(e.target.value) })}
              />
            </span>
          </label>

          <label className="settings-row">
            <span className="settings-label">Bell</span>
            <span className="settings-control">
              <select
                className="settings-select"
                value={prefs.bell}
                onChange={(e) => setPrefs({ bell: e.target.value as typeof prefs.bell })}
              >
                <option value="none">None</option>
                <option value="visual">Visual flash</option>
              </select>
            </span>
          </label>

          <label className="settings-row">
            <span className="settings-label">Dim inactive panes</span>
            <span className="settings-control">
              <input
                type="checkbox"
                checked={inactivePaneDimming}
                onChange={(e) => setInactivePaneDimming(e.target.checked)}
              />
            </span>
          </label>

          <label className="settings-row">
            <span className="settings-label">SFTP side pane</span>
            <span className="settings-control">
              <input
                type="checkbox"
                checked={sftpSidePane}
                onChange={(e) => setSftpSidePane(e.target.checked)}
              />
            </span>
          </label>

          <label className="settings-row">
            <span className="settings-label">Activity indicators</span>
            <span className="settings-control">
              <input
                type="checkbox"
                checked={activityIndicators}
                onChange={(e) => setActivityIndicators(e.target.checked)}
              />
            </span>
          </label>

          <label className="settings-row">
            <span className="settings-label">
              Persist search history
              <span className="settings-sub-hint" style={{ marginLeft: 6 }}>
                (5000 lines/session)
              </span>
            </span>
            <span className="settings-control">
              <input
                type="checkbox"
                checked={searchPersist}
                onChange={(e) => setSearchPersist(e.target.checked)}
              />
            </span>
          </label>

          <label className="settings-row">
            <span className="settings-label">
              Zen mode
              <span className="settings-sub-hint" style={{ marginLeft: 6 }}>
                {comboLabel(
                  HOTKEYS.find((h) => h.id === 'toggleZenMode')!,
                  window.devterm.platform === 'darwin'
                )}
              </span>
            </span>
            <span className="settings-control">
              <input
                type="checkbox"
                checked={zenMode}
                onChange={(e) => setZenMode(e.target.checked)}
              />
            </span>
          </label>
        </section>

        <section className="settings-section">
          <h3>Notifications</h3>
          <div className="settings-sub-hint">
            Get pulled back when a coding agent finishes or needs input — a chime, a green tab dot,
            and (when DevTerm is in the background) an OS notification with a taskbar flash. Only
            the agent pane is watched; normal terminals never raise an alert.
          </div>

          <label className="settings-row">
            <span className="settings-label">Attention alerts</span>
            <span className="settings-control">
              <input
                type="checkbox"
                checked={attention.enabled}
                onChange={(e) => setAttention({ enabled: e.target.checked })}
              />
            </span>
          </label>

          <label className="settings-row">
            <span className="settings-label">Play a chime</span>
            <span className="settings-control">
              <input
                type="checkbox"
                checked={attention.sound}
                disabled={!attention.enabled}
                onChange={(e) => setAttention({ sound: e.target.checked })}
              />
            </span>
          </label>

          <label className="settings-row">
            <span className="settings-label">
              Chime volume ({Math.round(attention.volume * 100)}%)
            </span>
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
              <button
                className="ghost small"
                disabled={!attention.enabled || !attention.sound}
                onClick={() => chime(attention.volume)}
                title="Preview the chime"
              >
                Test
              </button>
            </span>
          </label>

          <label className="settings-row">
            <span className="settings-label">System notification + taskbar flash</span>
            <span className="settings-control">
              <input
                type="checkbox"
                checked={attention.system}
                disabled={!attention.enabled}
                onChange={(e) => setAttention({ system: e.target.checked })}
              />
            </span>
          </label>

          <label className="settings-row">
            <span className="settings-label">
              Treat an agent going quiet as &ldquo;finished&rdquo;
            </span>
            <span className="settings-control">
              <input
                type="checkbox"
                checked={attention.idle}
                disabled={!attention.enabled}
                onChange={(e) => setAttention({ idle: e.target.checked })}
              />
            </span>
          </label>
        </section>

        <section className="settings-section">
          <h3>Voice dictation</h3>
          <div className="settings-sub-hint">
            Speak into the active terminal. Audio is transcribed <strong>locally</strong> by a
            Whisper speech model (WebGPU when available, otherwise CPU) — nothing is sent to the
            cloud. The model downloads once on first use and is cached for offline use. Toggle with
            the toolbar mic button or the dictation hotkey.
          </div>

          <label className="settings-row">
            <span className="settings-label">Enable voice dictation</span>
            <span className="settings-control">
              <input
                type="checkbox"
                checked={stt.enabled}
                onChange={(e) => setStt({ enabled: e.target.checked })}
              />
            </span>
          </label>

          <label className="settings-row">
            <span className="settings-label">Model</span>
            <span className="settings-control">
              <select
                className="settings-select"
                value={stt.modelId}
                disabled={!stt.enabled}
                onChange={(e) => setStt({ modelId: e.target.value as typeof stt.modelId })}
              >
                <option value="tiny">Tiny — fastest, ~75 MB, lower accuracy</option>
                <option value="base">Base — balanced, ~140 MB (recommended)</option>
                <option value="small">Small — most accurate, ~470 MB, GPU preferred</option>
              </select>
            </span>
          </label>

          <label className="settings-row">
            <span className="settings-label">Language</span>
            <span className="settings-control">
              <select
                className="settings-select"
                value={stt.language}
                disabled={!stt.enabled}
                onChange={(e) => setStt({ language: e.target.value as typeof stt.language })}
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
                <option value="ar">Arabic</option>
                <option value="hi">Hindi</option>
              </select>
            </span>
          </label>

          <label className="settings-row">
            <span className="settings-label">Append a trailing space after transcript</span>
            <span className="settings-control">
              <input
                type="checkbox"
                checked={stt.appendSpace}
                disabled={!stt.enabled}
                onChange={(e) => setStt({ appendSpace: e.target.checked })}
              />
            </span>
          </label>

          <label className="settings-row">
            <span className="settings-label">Show floating status pill</span>
            <span className="settings-control">
              <input
                type="checkbox"
                checked={stt.showFloatingStatus}
                disabled={!stt.enabled}
                onChange={(e) => setStt({ showFloatingStatus: e.target.checked })}
              />
            </span>
          </label>

          <label className="settings-row">
            <span className="settings-label">Cached model</span>
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
                        ? `Cleared ${targets.length} cached model store(s).`
                        : 'No cached model found.'
                    )
                  } catch (err) {
                    setSttHint(err instanceof Error ? err.message : 'Could not clear the cache.')
                  }
                }}
                title="Delete the downloaded speech model; it will re-download on next use"
              >
                Clear cached model
              </button>
            </span>
          </label>
          {sttHint && <div className="settings-sub-hint">{sttHint}</div>}
        </section>

        <section className="settings-section">
          <h3>Default local shell</h3>
          <div className="settings-sub-hint">
            What new local terminals spawn. <code>Auto</code> picks the best installed shell —
            PowerShell 7 when present (avoids Windows PowerShell 5.1&apos;s signature-check
            failure), else Windows PowerShell, else cmd.exe. Pick a specific shell to force it.
          </div>

          <label className="settings-row">
            <span className="settings-label">Shell</span>
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
            <label className="settings-row">
              <span className="settings-label">Path</span>
              <span className="settings-control">
                <input
                  className="settings-hex"
                  type="text"
                  spellCheck={false}
                  placeholder="C:\Program Files\PowerShell\7\pwsh.exe"
                  value={defaultShell.path}
                  onChange={(e) => setDefaultShell({ kind: 'custom', path: e.target.value })}
                />
              </span>
            </label>
          )}

          {window.devterm.platform === 'win32' && (
            <div className="settings-row">
              <span className="settings-label">Install PowerShell 7</span>
              <span className="settings-control">
                <button
                  className="ghost small"
                  disabled={pwshBusy}
                  title="Copy the winget command to the clipboard"
                  onClick={() =>
                    runShellPref(async () => {
                      await copyText('winget install Microsoft.PowerShell')
                    })
                  }
                >
                  Copy winget command
                </button>
                {shellHint && (
                  <span className="settings-sub-hint" style={{ marginLeft: 8 }}>
                    {shellHint}
                  </span>
                )}
              </span>
            </div>
          )}
        </section>

        <section className="settings-section">
          <h3>Connection</h3>
          <div className="settings-sub-hint">
            What to do when an SSH connection drops — DevTerm retries with exponential backoff so a
            flaky network doesn&apos;t interrupt your work.
          </div>

          <label className="settings-row">
            <span className="settings-label">Auto-reconnect on drop</span>
            <span className="settings-control">
              <input
                type="checkbox"
                checked={autoReconnect.enabled}
                onChange={(e) => setAutoReconnect({ enabled: e.target.checked })}
              />
            </span>
          </label>

          <label className="settings-row">
            <span className="settings-label">Max attempts ({autoReconnect.maxAttempts})</span>
            <span className="settings-control">
              <input
                type="range"
                min={1}
                max={20}
                step={1}
                value={autoReconnect.maxAttempts}
                disabled={!autoReconnect.enabled}
                onChange={(e) => setAutoReconnect({ maxAttempts: Number(e.target.value) })}
              />
            </span>
          </label>

          <label className="settings-row">
            <span className="settings-label">
              First retry in ({(autoReconnect.baseDelayMs / 1000).toFixed(1)}s)
            </span>
            <span className="settings-control">
              <input
                type="range"
                min={250}
                max={15000}
                step={250}
                value={autoReconnect.baseDelayMs}
                disabled={!autoReconnect.enabled}
                onChange={(e) => setAutoReconnect({ baseDelayMs: Number(e.target.value) })}
              />
            </span>
          </label>

          <label className="settings-row">
            <span className="settings-label">
              Max delay cap ({(autoReconnect.maxDelayMs / 1000).toFixed(0)}s)
            </span>
            <span className="settings-control">
              <input
                type="range"
                min={1000}
                max={120000}
                step={1000}
                value={autoReconnect.maxDelayMs}
                disabled={!autoReconnect.enabled}
                onChange={(e) => setAutoReconnect({ maxDelayMs: Number(e.target.value) })}
              />
            </span>
          </label>

          <label className="settings-row">
            <span className="settings-label">
              Backoff factor ({autoReconnect.factor.toFixed(1)}×)
            </span>
            <span className="settings-control">
              <input
                type="range"
                min={1}
                max={4}
                step={0.1}
                value={autoReconnect.factor}
                disabled={!autoReconnect.enabled}
                onChange={(e) => setAutoReconnect({ factor: Number(e.target.value) })}
              />
            </span>
          </label>
        </section>

        <section className="settings-section">
          <h3>Agent guardrails</h3>
          <div className="settings-sub-hint">
            Approval rules that override the per-session policy mode. Longest
            prefix wins; per-session rules beat same-length global rules.
            Rules added via &ldquo;Remember my choice&rdquo; in a confirm
            prompt land here.
          </div>

          <div className="rule-form">
            <label className="settings-row">
              <span className="settings-label">Command prefix</span>
              <span className="settings-control">
                <input
                  type="text"
                  className="text-input"
                  value={rulePrefix}
                  placeholder="e.g. kubectl get"
                  onChange={(e) => setRulePrefix(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void addRule()
                  }}
                />
              </span>
            </label>

            <label className="settings-row">
              <span className="settings-label">Outcome</span>
              <span className="settings-control">
                <select
                  className="text-input"
                  value={ruleOutcome}
                  onChange={(e) =>
                    setRuleOutcome(e.target.value as ApprovalRule['outcome'])
                  }
                >
                  <option value="allow">Allow (skip confirm)</option>
                  <option value="deny">Deny (always block)</option>
                  <option value="ask">Ask (always confirm)</option>
                </select>
              </span>
            </label>

            <label className="settings-row">
              <span className="settings-label">Scope</span>
              <span className="settings-control">
                <select
                  className="text-input"
                  value={ruleScope}
                  onChange={(e) =>
                    setRuleScope(e.target.value as 'global' | 'session')
                  }
                >
                  <option value="global">Global (all sessions)</option>
                  <option value="session">Per remote session</option>
                </select>
              </span>
            </label>

            {ruleScope === 'session' && (
              <label className="settings-row">
                <span className="settings-label">Session</span>
                <span className="settings-control">
                  <select
                    className="text-input"
                    value={ruleSessionId}
                    onChange={(e) => setRuleSessionId(e.target.value)}
                  >
                    <option value="" disabled>
                      Pick a session…
                    </option>
                    {remoteSessions.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.context?.hostname || s.title || s.id}
                      </option>
                    ))}
                  </select>
                </span>
              </label>
            )}

            <div className="settings-row">
              <span className="settings-label" />
              <span className="settings-control">
                <button
                  className="primary"
                  disabled={ruleBusy || !rulePrefix.trim()}
                  onClick={() => void addRule()}
                >
                  {ruleBusy ? 'Adding…' : 'Add rule'}
                </button>
                {ruleHint && <span className="settings-hint">{ruleHint}</span>}
              </span>
            </div>
          </div>

          {rules.length === 0 ? (
            <div className="settings-empty">No approval rules yet.</div>
          ) : (
            <ul className="rule-list">
              {rules.map((r) => (
                <li key={r.id} className="rule-row">
                  <span
                    className={`rule-outcome rule-outcome-${r.outcome}`}
                    title={
                      r.outcome === 'allow'
                        ? 'Allow without prompting'
                        : r.outcome === 'deny'
                          ? 'Always block'
                          : 'Always prompt'
                    }
                  >
                    {r.outcome}
                  </span>
                  <code className="rule-prefix">{r.commandPrefix}</code>
                  <span className="rule-scope">
                    {r.sessionId
                      ? `session: ${r.sessionId.slice(0, 8)}…`
                      : 'global'}
                  </span>
                  <button
                    className="ghost small"
                    onClick={() => void removeRule(r.id)}
                    title="Delete rule"
                  >
                    Delete
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="settings-section">
          <h3>Background image</h3>
          <div className="settings-sub-hint">Optional — overlays the theme colour.</div>

          <label className="settings-row">
            <span className="settings-label">Image</span>
            <span className="settings-control">
              <button className="primary" disabled={busy} onClick={chooseImage}>
                {busy ? 'Loading…' : terminalBg.image ? 'Replace image…' : 'Choose image…'}
              </button>
              {terminalBg.image && (
                <button className="danger" onClick={() => setTerminalBg({ image: null })}>
                  Remove
                </button>
              )}
            </span>
          </label>
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
                <span>preview</span>
              </div>
              <label className="settings-row">
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
        </section>

        <section className="settings-section">
          <h3>Keyboard</h3>
          <div className="settings-sub-hint">
            Click Edit next to an action, then press the new shortcut. Modifiers are required.
          </div>

          <div className="kb-list">
            {HOTKEYS.filter((h) => !h.alias).map((h) => {
              const custom = keybindings[h.id]
              const combo = custom ?? { mod: h.mod, shift: h.shift, alt: h.alt, key: h.key }
              const isCapturing = capturing === h.id
              return (
                <div key={h.id} className="kb-row">
                  <span className="kb-label">{h.label}</span>
                  <span className={`kb-combo ${custom ? 'is-custom' : ''}`}>
                    {isCapturing
                      ? 'Press new shortcut…'
                      : comboLabel({ ...h, ...combo }, window.devterm.platform === 'darwin')}
                  </span>
                  <button
                    className="ghost small"
                    onClick={() => setCapturing(h.id)}
                    disabled={isCapturing}
                  >
                    Edit
                  </button>
                  {custom && (
                    <button className="ghost small" onClick={() => setKeybinding(h.id, null)}>
                      Reset
                    </button>
                  )}
                </div>
              )
            })}
          </div>
          {capturing && (
            <div className="kb-capture-overlay" onClick={() => setCapturing(null)}>
              <div className="kb-capture-box">
                Press the new shortcut for {HOTKEYS.find((h) => h.id === capturing)?.label}
              </div>
            </div>
          )}
          <div className="settings-row">
            <span className="settings-label" />
            <span className="settings-control">
              <button className="ghost" onClick={resetKeybindings}>
                Reset all to defaults
              </button>
            </span>
          </div>
        </section>

        <section className="settings-section">
          <h3>Data</h3>
          <div className="settings-sub-hint">
            Back up or restore saved connections, snippets, workspaces, and approval rules. Export
            strips secrets; import merges with your existing data.
          </div>

          <div className="settings-row">
            <span className="settings-label">Settings backup</span>
            <span className="settings-control">
              <button className="ghost" onClick={() => void runExport()}>
                Export…
              </button>
              <button className="ghost" onClick={() => void runImport()}>
                Import…
              </button>
            </span>
          </div>
          {ioHint && <div className="settings-error">{ioHint}</div>}
        </section>

        <div className="modal-foot">
          <button
            className="ghost"
            onClick={() => {
              reset()
              applyTheme(getTheme(useSettings.getState().themeId))
            }}
          >
            Reset to defaults
          </button>
          <button className="primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
