import { useState } from 'react'
import { useSettings } from '../store/settings'
import { THEMES, getTheme, applyTheme, type Theme } from '../lib/themes'
import { IconClose } from './Icons'

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
        style={{ background: t.background, borderColor: theme.chrome.border }}
      >
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
  const reset = useSettings((s) => s.reset)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

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
