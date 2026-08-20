import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent
} from 'react'
import type { TmuxSessionInfo } from '@shared/types'
import { useEscapeKey } from '../../lib/useEscapeKey'
import ConfirmDialog from '../common/ConfirmDialog'

const NORMAL = '__normal__'

function sanitizeName(raw: string): string {
  return raw
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48)
}

function formatAgo(epochSec?: number): string | undefined {
  if (!epochSec) return undefined
  const delta = Math.max(0, Math.floor(Date.now() / 1000 - epochSec))
  if (delta < 45) return 'just now'
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`
  if (delta < 86400 * 14) return `${Math.floor(delta / 86400)}d ago`
  return new Date(epochSec * 1000).toLocaleDateString()
}

function shortenPath(p: string, max = 48): string {
  if (p.length <= max) return p
  const parts = p.split('/').filter(Boolean)
  if (parts.length >= 2) return `…/${parts.slice(-2).join('/')}`
  return `…${p.slice(-(max - 1))}`
}

function windowCount(n: number): string {
  return n === 1 ? '1 window' : `${n || '?'} windows`
}

function clientCount(n: number): string {
  if (n <= 0) return 'no clients'
  return n === 1 ? '1 client' : `${n} clients`
}

function TmuxMark() {
  return (
    <svg className="tmux-picker-mark" viewBox="0 0 20 20" aria-hidden="true">
      <rect
        x="1.5"
        y="1.5"
        width="17"
        height="17"
        rx="3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <path d="M10 2v16M2 8.5h16" fill="none" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  )
}

export default function TmuxPicker({
  sessions,
  version,
  mode = 'connect',
  attachedName,
  onAttach,
  onNormal,
  onCreate,
  onClose,
  onKill
}: {
  sessions: TmuxSessionInfo[]
  version?: string
  /** First connect vs reopened from a live pane. */
  mode?: 'connect' | 'browse'
  /** Session this pane is currently attached to, if any. */
  attachedName?: string
  onAttach: (name: string) => void
  onNormal: () => void
  onCreate: (name: string) => void
  onClose: () => void
  onKill: (name: string) => Promise<void>
}) {
  const titleId = useId()
  const [draft, setDraft] = useState('')
  const [active, setActive] = useState<string>(attachedName || sessions[0]?.name || NORMAL)
  const [killTarget, setKillTarget] = useState<string | null>(null)
  const [killing, setKilling] = useState(false)
  const [killError, setKillError] = useState<string | null>(null)
  const firstRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const dismiss = mode === 'connect' ? onNormal : onClose
  useEscapeKey(dismiss, !killTarget)

  useEffect(() => {
    firstRef.current?.focus()
  }, [])

  useEffect(() => {
    if (active !== NORMAL && !sessions.some((s) => s.name === active)) {
      setActive(sessions[0]?.name ?? NORMAL)
    }
  }, [sessions, active])

  const created = sanitizeName(draft)
  const ids = useMemo(() => [NORMAL, ...sessions.map((s) => s.name)], [sessions])
  const selected = sessions.find((s) => s.name === active)
  const browse = mode === 'browse'

  const confirmActive = () => {
    if (active === NORMAL) {
      if (browse && attachedName) onNormal()
      else dismiss()
    } else onAttach(active)
  }

  const move = (delta: number) => {
    const i = Math.max(0, ids.indexOf(active))
    const next = ids[(i + delta + ids.length) % ids.length]
    setActive(next)
    const buttons = listRef.current?.querySelectorAll<HTMLButtonElement>('[data-tmux-opt]')
    buttons?.forEach((btn) => {
      if (btn.dataset.tmuxOpt === next) btn.scrollIntoView({ block: 'nearest' })
    })
  }

  const onListKey = (e: ReactKeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      move(1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      move(-1)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      confirmActive()
    } else if (e.key === 'Home') {
      e.preventDefault()
      setActive(ids[0] ?? NORMAL)
    } else if (e.key === 'End') {
      e.preventDefault()
      setActive(ids[ids.length - 1] ?? NORMAL)
    } else if (e.key === 'Delete' && selected) {
      e.preventDefault()
      setKillError(null)
      setKillTarget(selected.name)
    }
  }

  const activityLabel = selected
    ? (formatAgo(selected.activity) ?? formatAgo(selected.created))
    : undefined

  return (
    <div
      className="tmux-picker"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onClick={(e) => {
        if (e.target === e.currentTarget) dismiss()
      }}
    >
      <div
        className="tmux-picker-card"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.target instanceof HTMLInputElement) return
          if (e.target instanceof HTMLButtonElement && e.key === 'Enter') return
          onListKey(e)
        }}
      >
        <header className="tmux-picker-head">
          <div className="tmux-picker-head-row">
            <TmuxMark />
            <div className="tmux-picker-head-text">
              <h3 id={titleId}>{browse ? 'tmux sessions' : 'Attach to a tmux session'}</h3>
              <p className="tmux-picker-sub">
                {browse
                  ? 'Preview a session, attach or switch to it, or shut it down.'
                  : 'Preview the live pane, then attach — or stay in a normal login shell.'}
              </p>
            </div>
          </div>
          <div className="tmux-picker-head-meta">
            {version && <span className="tmux-picker-chip">{version}</span>}
            <span className="tmux-picker-chip">
              {sessions.length === 0
                ? 'No sessions'
                : sessions.length === 1
                  ? '1 session'
                  : `${sessions.length} sessions`}
            </span>
          </div>
        </header>

        <div className="tmux-picker-body">
          <div
            ref={listRef}
            className="tmux-picker-list"
            role="listbox"
            aria-labelledby={titleId}
            aria-activedescendant={`${titleId}-opt-${Math.max(0, ids.indexOf(active))}`}
          >
            <button
              ref={sessions.length === 0 ? firstRef : undefined}
              id={`${titleId}-opt-0`}
              data-tmux-opt={NORMAL}
              type="button"
              className={`tmux-picker-row tmux-picker-row-normal${active === NORMAL ? ' is-active' : ''}`}
              role="option"
              aria-selected={active === NORMAL}
              onMouseEnter={() => setActive(NORMAL)}
              onClick={browse && attachedName ? onNormal : dismiss}
            >
              <span className="tmux-picker-row-top">
                <span className="tmux-picker-name">
                  {browse && attachedName ? 'Detach to login shell' : 'Normal terminal'}
                </span>
                <span className="tmux-picker-pill">no tmux</span>
              </span>
              <span className="tmux-picker-cmd">
                {browse && attachedName
                  ? 'Leave the current tmux session; prefix+d does the same'
                  : 'Login shell — skip detached sessions'}
              </span>
            </button>

            {sessions.map((s, i) => {
              const ago = formatAgo(s.activity) ?? formatAgo(s.created)
              const cmd = s.currentCommand || s.currentWindow
              return (
                <button
                  key={s.name}
                  ref={i === 0 ? firstRef : undefined}
                  id={`${titleId}-opt-${i + 1}`}
                  data-tmux-opt={s.name}
                  type="button"
                  className={`tmux-picker-row${active === s.name ? ' is-active' : ''}`}
                  role="option"
                  aria-selected={active === s.name}
                  onMouseEnter={() => setActive(s.name)}
                  onClick={() => onAttach(s.name)}
                >
                  <span className="tmux-picker-row-top">
                    <span className="tmux-picker-name">{s.name}</span>
                    <span className="tmux-picker-pills">
                      {attachedName === s.name && (
                        <span className="tmux-picker-pill is-here">this pane</span>
                      )}
                      <span className={`tmux-picker-pill${s.attached > 0 ? ' is-live' : ''}`}>
                        {s.attached > 0 ? 'attached' : 'detached'}
                      </span>
                    </span>
                  </span>
                  <span className="tmux-picker-cmd">
                    {cmd ? <code>{cmd}</code> : 'idle'}
                    {s.currentPath ? `  ${shortenPath(s.currentPath, 36)}` : ''}
                  </span>
                  <span className="tmux-picker-meta">
                    {windowCount(s.windows)}
                    {' · '}
                    {clientCount(s.attached)}
                    {ago ? ` · ${ago}` : ''}
                  </span>
                </button>
              )
            })}

            {sessions.length === 0 && (
              <p className="tmux-picker-empty">
                No sessions yet on this host. Create one below, or use a normal shell.
              </p>
            )}
          </div>

          <aside className="tmux-picker-preview" aria-live="polite">
            {selected ? (
              <>
                <div className="tmux-picker-preview-bar">
                  <div className="tmux-picker-preview-title">
                    <strong>{selected.name}</strong>
                    <span>
                      {selected.currentWindow || 'window'}
                      {selected.currentCommand ? ` · ${selected.currentCommand}` : ''}
                    </span>
                  </div>
                  <div className="tmux-picker-preview-actions">
                    <button
                      type="button"
                      className="tmux-picker-kill"
                      onClick={() => {
                        setKillError(null)
                        setKillTarget(selected.name)
                      }}
                    >
                      Kill session
                    </button>
                    <button
                      type="button"
                      className="tmux-picker-attach"
                      onClick={() =>
                        attachedName === selected.name ? onClose() : onAttach(selected.name)
                      }
                    >
                      {attachedName === selected.name ? 'Stay attached' : 'Attach'}
                    </button>
                  </div>
                </div>
                {selected.windowList && selected.windowList.length > 0 && (
                  <div className="tmux-picker-wins">
                    {selected.windowList.map((w) => (
                      <span
                        key={w}
                        className={`tmux-picker-win${w.endsWith('*') ? ' is-active' : ''}`}
                      >
                        {w}
                      </span>
                    ))}
                  </div>
                )}
                {killError && <p className="tmux-picker-error">{killError}</p>}
                <pre className="tmux-picker-preview-pane">
                  {selected.preview || 'No visible output in the active pane.'}
                </pre>
                <div className="tmux-picker-preview-foot">
                  {selected.currentPath && (
                    <span className="tmux-picker-path" title={selected.currentPath}>
                      {shortenPath(selected.currentPath)}
                    </span>
                  )}
                  <span>
                    {windowCount(selected.windows)}
                    {activityLabel ? ` · active ${activityLabel}` : ''}
                  </span>
                </div>
              </>
            ) : (
              <>
                <div className="tmux-picker-preview-bar">
                  <div className="tmux-picker-preview-title">
                    <strong>Normal terminal</strong>
                    <span>Login shell</span>
                  </div>
                  <button type="button" className="tmux-picker-attach" onClick={onNormal}>
                    Continue
                  </button>
                </div>
                <pre className="tmux-picker-preview-pane tmux-picker-preview-muted">
                  Skip tmux and land in a regular login shell on this host. Detach (prefix+d) from a
                  session later returns here too.
                </pre>
              </>
            )}
          </aside>
        </div>

        <form
          className="tmux-picker-new"
          onSubmit={(e) => {
            e.preventDefault()
            if (created) onCreate(created)
          }}
        >
          <label className="tmux-picker-new-label" htmlFor={`${titleId}-new`}>
            New session
          </label>
          <div className="tmux-picker-new-row">
            <input
              id={`${titleId}-new`}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="name"
              autoComplete="off"
              spellCheck={false}
            />
            <button type="submit" disabled={!created}>
              Create &amp; attach
            </button>
          </div>
        </form>
      </div>
      <ConfirmDialog
        open={killTarget !== null}
        title="Kill tmux session?"
        confirmLabel={killing ? 'Killing…' : 'Kill session'}
        message={
          killTarget ? (
            <>
              This destroys <code>{killTarget}</code> and every window in it. Attached clients drop
              back to a login shell. This cannot be undone.
            </>
          ) : null
        }
        onClose={() => {
          if (!killing) setKillTarget(null)
        }}
        onConfirm={() => {
          if (!killTarget || killing) return
          const name = killTarget
          setKilling(true)
          void onKill(name)
            .then(() => {
              setKillTarget(null)
              setKillError(null)
              if (active === name) setActive(NORMAL)
            })
            .catch((err: unknown) => {
              setKillError(err instanceof Error ? err.message : String(err))
              setKillTarget(null)
            })
            .finally(() => setKilling(false))
        }}
      />
    </div>
  )
}
