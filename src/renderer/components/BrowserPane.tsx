import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState
} from 'react'
import { useSessions, type Session } from '../store/sessions'
import { registerBrowserGuest } from '../lib/browserTabs'
import type { BrowserDownloadItem } from '@shared/types'

/** Default landing page and search engine. */
const HOME_URL = 'https://www.google.com'

/**
 * Turn an address-bar entry into a URL. An explicit scheme is kept as-is; a bare
 * host (`example.com`, `localhost:3000`) gets http(s); anything else becomes a
 * Google search, so the bar doubles as a search box.
 */
function toUrl(raw: string): string {
  const q = raw.trim()
  if (!q) return HOME_URL
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(q)) return q
  if (/^localhost(:\d+)?(\/.*)?$/i.test(q)) return `http://${q}`
  if (!/\s/.test(q) && /^[^\s.]+\.[^\s]{2,}/.test(q)) return `https://${q}`
  return `https://www.google.com/search?q=${encodeURIComponent(q)}`
}

function originOf(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return ''
  }
}

let tabSeq = 0
const newTabId = () => `tab-${Date.now()}-${(tabSeq++).toString(36)}`

/** Per-tab state held by the pane; the toolbar reflects the active tab. */
interface TabState {
  id: string
  initialUrl: string
  title: string
  /** Last committed main-frame URL (restored into the address bar on tab switch). */
  current: string
  loading: boolean
  canBack: boolean
  canFwd: boolean
  /** Per-tab zoom level (renderer-side cache, persisted in main on change). */
  zoom: number
  /** Per-tab mute state. */
  muted: boolean
  /** webContents id once the guest has been attached. */
  webContentsId: number | null
  /**
   * Number of matches from the most recent `findInPage` call on this tab.
   * Updated by the `found-in-page` webview event. The find bar reads this
   * to render "n / m" / "No results" next to the input.
   */
  findMatches: number
  /**
   * 1-based index of the currently-highlighted match (matches Electron's
   * `activeMatchOrdinal` in the `found-in-page` event payload). 0 means
   * "no match" / "not yet known".
   */
  findActive: number
}

function makeTab(url: string, zoom = 1): TabState {
  return {
    id: newTabId(),
    initialUrl: url,
    title: 'New Tab',
    current: url,
    loading: false,
    canBack: false,
    canFwd: false,
    zoom,
    muted: false,
    webContentsId: null,
    findMatches: 0,
    findActive: 0
  }
}

/** Imperative surface the pane toolbar drives on the active tab. */
interface TabHandle {
  back(): void
  forward(): void
  reloadOrStop(): void
  loadURL(url: string): void
  zoomIn(): void
  zoomOut(): void
  zoomReset(): void
  openDevtools(): void
  toggleMute(): void
  /** Kick off a fresh find (or re-find) for `text` in the active direction. */
  find(text: string, forward?: boolean): void
  /** Step to the next/previous match in the same query. */
  findNext(forward?: boolean): void
  stopFind(): void
}

type StatePatch = Partial<Omit<TabState, 'id' | 'initialUrl' | 'title'>>

/**
 * One browser tab: an isolated, out-of-process Electron <webview> guest under the
 * shared persistent partition (so logins/cookies are shared across tabs and panes
 * and survive restarts). It stays mounted (display toggled by the parent) so its
 * page and scroll position survive tab switches; it reports nav/title changes up
 * and registers itself so main-process new-window requests land here as new tabs.
 *
 * Cluster D additions:
 *  - On `did-navigate` the per-origin persisted zoom level is applied to the
 *    guest, so re-opening a tab on a previously visited origin restores zoom.
 *  - `/` opens a find bar (handled in the parent toolbar).
 *  - Ctrl+Plus / Minus / 0 changes the zoom live and persists it.
 *  - Mute is plumbed through to `webContents.setAudioMuted`.
 */
const BrowserTab = memo(
  forwardRef<
    TabHandle,
    {
      tab: TabState
      onState: (id: string, patch: StatePatch) => void
      onTitle: (id: string, title: string) => void
      onOpenTab: (url: string) => void
      onWebContents: (id: string, wcId: number | null) => void
    }
  >(function BrowserTab({ tab, onState, onTitle, onOpenTab, onWebContents }, ref) {
    const el = useRef<Electron.WebviewTag | null>(null)
    // Refs to the latest tab/props so the imperative handle stays stable
    // (no churn) while still reading live state when invoked.
    const tabRef = useRef(tab)
    tabRef.current = tab
    const onStateRef = useRef(onState)
    onStateRef.current = onState
    // The most recent find query on this tab, so the up/down step buttons
    // can re-run the same search with a different direction. The query is
    // intentionally kept in a ref (not React state) because it lives in
    // parallel to the input the user typed into the find bar; the input is
    // the source of truth, the ref just mirrors it for the imperative API.
    const lastFindRef = useRef<{ text: string; forward: boolean }>({ text: '', forward: true })

    const adjustZoom = (delta: number | null): void => {
      const t = tabRef.current
      const cur = t.zoom
      const next = delta === null ? 1 : Math.max(0.5, Math.min(3, +(cur + delta).toFixed(2)))
      if (next === cur) return
      onStateRef.current(t.id, { zoom: next })
      const origin = originOf(t.current || t.initialUrl)
      if (origin) void window.devterm.browserZoom.set(origin, next)
      // Apply live so the user sees the change immediately. Electron's
      // zoomLevel is log(1.2)-scaled.
      const lv = Math.log(next) / Math.log(1.2)
      try {
        el.current?.setZoomLevel(lv)
      } catch {
        /* ignore */
      }
    }

    useImperativeHandle(
      ref,
      () => ({
        back: () => el.current?.goBack(),
        forward: () => el.current?.goForward(),
        reloadOrStop: () => (tabRef.current.loading ? el.current?.stop() : el.current?.reload()),
        loadURL: (url: string) => el.current?.loadURL(url),
        zoomIn: () => adjustZoom(0.1),
        zoomOut: () => adjustZoom(-0.1),
        zoomReset: () => adjustZoom(null),
        openDevtools: () => {
          const wcId = el.current?.getWebContentsId()
          if (wcId != null) void window.devterm.openBrowserDevtools(wcId)
        },
        toggleMute: () => {
          const wcId = el.current?.getWebContentsId()
          if (wcId == null) return
          const next = !tabRef.current.muted
          void window.devterm.setBrowserMuted(wcId, next)
          onStateRef.current(tabRef.current.id, { muted: next })
        },
        find: (text: string, forward = true) => {
          if (!el.current) return
          if (!text) {
            el.current.stopFindInPage('clearSelection')
            lastFindRef.current = { text: '', forward: true }
            return
          }
          lastFindRef.current = { text, forward }
          el.current.findInPage(text, { forward })
        },
        findNext: (forward = true) => {
          if (!el.current) return
          const { text } = lastFindRef.current
          if (!text) return
          // Electron's findInPage re-uses the previous query when called
          // with the same string; passing a different `forward` direction
          // steps to the next/previous match. No need to re-issue the
          // text — just flip the direction.
          el.current.findInPage(text, { forward })
        },
        stopFind: () => el.current?.stopFindInPage('clearSelection')
      }),
      []
    )

    useEffect(() => {
      const wv = el.current
      if (!wv) return
      const id = tab.id
      const setLoading = (v: boolean) => {
        onState(id, { loading: v })
      }
      const refreshNav = () => onState(id, { canBack: wv.canGoBack(), canFwd: wv.canGoForward() })

      // No manual removeEventListener: the <webview> is destroyed when the tab
      // unmounts, so its listeners die with it (the app has no StrictMode, and
      // tab.id is stable for the tab's lifetime).
      wv.addEventListener('did-start-loading', () => {
        setLoading(true)
        // A new page wipes the previous page's matches; clear the find bar
        // result so the count doesn't read stale from the prior page.
        onState(id, { findMatches: 0, findActive: 0 })
      })
      wv.addEventListener('did-stop-loading', () => {
        setLoading(false)
        refreshNav()
      })
      // The `found-in-page` event fires for every `findInPage(...)` call
      // (and once at the end of an incremental search with `finalUpdate`).
      // We surface both the total count and the 1-based active match
      // ordinal so the find bar can render "n / m" and step through
      // matches with up/down.
      wv.addEventListener('found-in-page', (e: Event) => {
        const detail = (e as unknown as {
          result: { matches: number; activeMatchOrdinal: number; finalUpdate?: boolean }
        }).result
        if (!detail) return
        // Only the final update is authoritative; intermediate events can
        // report partial matches. Stash on every fire so the bar can show
        // "searching…" between ticks if it wants, but commit the final
        // count when the last event arrives.
        onState(id, { findMatches: detail.matches, findActive: detail.activeMatchOrdinal })
      })
      wv.addEventListener('did-navigate', async (e) => {
        onState(id, { current: e.url, findMatches: 0, findActive: 0 })
        refreshNav()
        const origin = originOf(e.url)
        if (origin) {
          const z = await window.devterm.browserZoom.get(origin)
          onState(id, { zoom: z })
          try {
            wv.setZoomLevel(Math.log(z) / Math.log(1.2))
          } catch {
            /* ignore */
          }
        }
      })
      wv.addEventListener('did-navigate-in-page', (e) => {
        if (e.isMainFrame) onState(id, { current: e.url })
      })
      wv.addEventListener('page-title-updated', (e) => onTitle(id, e.title || 'New Tab'))
      // Apply the initial zoom level (from store or default) once the guest is
      // alive, so the very first paint reflects the user's saved preference.
      wv.addEventListener('dom-ready', () => {
        const wcId = wv.getWebContentsId()
        onWebContents(id, wcId)
        try {
          wv.setZoomLevel(Math.log(tab.zoom) / Math.log(1.2))
        } catch {
          /* ignore */
        }
      })

      // Map this guest's webContents id → this pane's add-tab opener, so main can
      // route its new-window requests back here. Register once on first dom-ready
      // (the guest's webContents id is stable for the <webview>'s lifetime).
      let unregister = () => {}
      const onReady = () => {
        unregister()
        unregister = registerBrowserGuest(wv.getWebContentsId(), onOpenTab)
      }
      wv.addEventListener('dom-ready', onReady)
      return () => {
        unregister()
        onWebContents(id, null)
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tab.id])

    return (
      <webview
        ref={el}
        className="browser-webview"
        src={tab.initialUrl}
        partition="persist:browser"
        // Lets the guest open popups (target=_blank / window.open). Without it
        // Electron silently drops those requests so they never reach main's
        // setWindowOpenHandler — which is what denies the OS popup and routes the
        // URL back here as a new tab (see registerBrowserGuest above +
        // src/main/index.ts) — making "open in new tab" links look dead. The value
        // must hit the DOM as a string: react-dom doesn't know this non-standard
        // attribute and strips boolean values, while @types/react types it as
        // boolean. So we render "" (presence is all Electron checks) and cast.
        allowpopups={'' as unknown as boolean}
      />
    )
  })
)

/**
 * In-app browser pane with multiple tabs. The pane is a single layout leaf (one
 * `kind:'browser'` session); tabs live inside it. Open more panes for separate
 * "windows" — they share the persistent partition, so logins carry across both.
 *
 * Cluster D additions on top of the original:
 *  - Downloads manager: a side drawer listing the active downloads (subscribed
 *    to via `browserDownloads.onUpdate`); per-row Open-in-folder + Cancel.
 *  - Zoom: Ctrl/Cmd+Plus/Minus/0 changes the active tab's zoom and persists
 *    the per-origin level in main. `/` opens a find bar that calls
 *    `webview.findInPage`.
 *  - DevTools: a toolbar button opens detached DevTools for the active tab.
 *  - Mute: a per-tab speaker icon toggles `webContents.setAudioMuted`.
 */
function BrowserPane({ session }: { session: Session }) {
  const [tabs, setTabs] = useState<TabState[]>(() => [makeTab(session.url ?? HOME_URL)])
  const [activeId, setActiveId] = useState(tabs[0].id)
  const [address, setAddress] = useState(tabs[0].current)
  const [dlDrawerOpen, setDlDrawerOpen] = useState(false)
  const [downloads, setDownloads] = useState<BrowserDownloadItem[]>([])
  const [find, setFind] = useState<{ open: boolean; text: string }>({ open: false, text: '' })
  const handles = useRef(new Map<string, TabHandle>())
  const activeRef = useRef(activeId)
  activeRef.current = activeId

  // Subscribe to the live download list. The preload wrapper delivers the
  // initial snapshot on subscribe and re-fires on every change. We do NOT
  // filter by source — the persistent partition means any tab (or even any
  // browser pane across the app) shares the same download stream.
  useEffect(() => {
    const off = window.devterm.browserDownloads.onUpdate((items) => {
      setDownloads(items)
    })
    return off
  }, [])

  // Global keyboard shortcuts scoped to the active pane. Ctrl/Cmd+Plus /
  // Minus / 0 zoom the active tab. `/` opens the find bar.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Skip when the user is typing into the find bar input or the address bar.
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      // Esc closes the find bar.
      if (e.key === 'Escape' && find.open) {
        e.preventDefault()
        setFind({ open: false, text: '' })
        handles.current.get(activeRef.current)?.stopFind()
        return
      }
      // `/` opens find — single character, no modifiers. We also catch the
      // Shift+/ variant so the user doesn't have to release shift first.
      if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey && !find.open) {
        e.preventDefault()
        setFind({ open: true, text: '' })
        return
      }
      const mod = e.ctrlKey || e.metaKey
      if (!mod) return
      if (e.key === '=' || e.key === '+') {
        e.preventDefault()
        handles.current.get(activeRef.current)?.zoomIn()
      } else if (e.key === '-') {
        e.preventDefault()
        handles.current.get(activeRef.current)?.zoomOut()
      } else if (e.key === '0') {
        e.preventDefault()
        handles.current.get(activeRef.current)?.zoomReset()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [find.open])

  const onState = useCallback((id: string, patch: StatePatch) => {
    setTabs((ts) => ts.map((t) => (t.id === id ? { ...t, ...patch } : t)))
    if (id === activeRef.current && patch.current !== undefined) setAddress(patch.current)
  }, [])

  const onTitle = useCallback((id: string, title: string) => {
    setTabs((ts) => ts.map((t) => (t.id === id ? { ...t, title } : t)))
  }, [])

  const onWebContents = useCallback((id: string, wcId: number | null) => {
    setTabs((ts) => ts.map((t) => (t.id === id ? { ...t, webContentsId: wcId } : t)))
  }, [])

  const addTab = useCallback((url: string = HOME_URL) => {
    const t = makeTab(url)
    setTabs((ts) => [...ts, t])
    setActiveId(t.id)
  }, [])

  const closeTab = useCallback(
    (id: string) => {
      handles.current.delete(id)
      setTabs((ts) => {
        if (ts.length <= 1) {
          // Closing the last tab closes the whole pane (its layout leaf).
          useSessions.getState().close(session.id)
          return ts
        }
        const idx = ts.findIndex((t) => t.id === id)
        const next = ts.filter((t) => t.id !== id)
        setActiveId((cur) => (cur === id ? next[Math.min(idx, next.length - 1)].id : cur))
        return next
      })
    },
    [session.id]
  )

  // Restore the address bar to the active tab's URL when switching tabs (live
  // navigation of the active tab updates it via onState). Intentionally excludes
  // `tabs` so a background tab's update can't clobber what the user is typing.
  useEffect(() => {
    const at = tabs.find((t) => t.id === activeId)
    if (at) setAddress(at.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId])

  // Mirror the active tab's title onto the session so the layout tab shows the page.
  const activeTab = tabs.find((t) => t.id === activeId)
  useEffect(() => {
    useSessions.getState().setTitle(session.id, activeTab?.title || 'Browser')
  }, [session.id, activeTab?.title])

  const go = (raw: string) => {
    const url = toUrl(raw)
    setAddress(url)
    handles.current.get(activeId)?.loadURL(url)
  }

  const loading = activeTab?.loading ?? false
  const activeDownloads = useMemo(
    () => downloads.filter((d) => d.state === 'progressing'),
    [downloads]
  )
  const finishedDownloads = useMemo(
    () => downloads.filter((d) => d.state !== 'progressing'),
    [downloads]
  )
  const dlCount = activeDownloads.length

  const submitFind = (text: string) => {
    setFind({ open: true, text })
    handles.current.get(activeId)?.find(text, true)
  }

  return (
    <div className="browser-pane">
      <div className="browser-tabs">
        {tabs.map((t) => (
          <div
            key={t.id}
            className={`browser-tab ${t.id === activeId ? 'active' : ''} ${t.muted ? 'is-muted' : ''}`}
            title={t.title}
            onMouseDown={(e) => {
              // Middle-click closes, like a real browser.
              if (e.button === 1) {
                e.preventDefault()
                closeTab(t.id)
              } else if (e.button === 0) {
                setActiveId(t.id)
              }
            }}
          >
            <span className="browser-tab-title">{t.title}</span>
            <button
              className="browser-tab-mute"
              title={t.muted ? 'Unmute tab' : 'Mute tab'}
              onClick={(e) => {
                e.stopPropagation()
                handles.current.get(t.id)?.toggleMute()
              }}
            >
              {t.muted ? '🔇' : '🔊'}
            </button>
            <button
              className="browser-tab-close"
              title="Close tab"
              onClick={(e) => {
                e.stopPropagation()
                closeTab(t.id)
              }}
            >
              ✕
            </button>
          </div>
        ))}
        <button className="browser-tab-new" title="New tab" onClick={() => addTab()}>
          ＋
        </button>
      </div>
      <div className="browser-toolbar">
        <button
          className="browser-btn"
          title="Back"
          disabled={!activeTab?.canBack}
          onClick={() => handles.current.get(activeId)?.back()}
        >
          ‹
        </button>
        <button
          className="browser-btn"
          title="Forward"
          disabled={!activeTab?.canFwd}
          onClick={() => handles.current.get(activeId)?.forward()}
        >
          ›
        </button>
        <button
          className="browser-btn"
          title={loading ? 'Stop' : 'Reload'}
          onClick={() => handles.current.get(activeId)?.reloadOrStop()}
        >
          {loading ? '✕' : '⟳'}
        </button>
        <button className="browser-btn" title="Home" onClick={() => go(HOME_URL)}>
          ⌂
        </button>
        <form
          className="browser-addr-form"
          onSubmit={(e) => {
            e.preventDefault()
            go(address)
          }}
        >
          <input
            className="browser-addr"
            value={address}
            spellCheck={false}
            placeholder="Search or enter address  (press / to find)"
            onChange={(e) => setAddress(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
          />
        </form>
        <button
          className="browser-btn"
          title="Zoom out (Ctrl/Cmd+-)"
          onClick={() => handles.current.get(activeId)?.zoomOut()}
        >
          −
        </button>
        <span className="browser-zoom-label" title="Per-origin zoom level">
          {Math.round((activeTab?.zoom ?? 1) * 100)}%
        </span>
        <button
          className="browser-btn"
          title="Zoom in (Ctrl/Cmd++)"
          onClick={() => handles.current.get(activeId)?.zoomIn()}
        >
          +
        </button>
        <button
          className="browser-btn"
          title="Reset zoom (Ctrl/Cmd+0)"
          onClick={() => handles.current.get(activeId)?.zoomReset()}
        >
          100%
        </button>
        <button
          className={`browser-btn browser-dl-btn ${dlCount > 0 ? 'has-active' : ''}`}
          title={
            dlCount > 0 ? `${dlCount} active download${dlCount === 1 ? '' : 's'}` : 'Downloads'
          }
          onClick={() => setDlDrawerOpen((v) => !v)}
        >
          ⬇
          {dlCount > 0 && <span className="browser-dl-count">{dlCount}</span>}
        </button>
        <button
          className="browser-btn"
          title="Open DevTools for this tab (detached)"
          onClick={() => handles.current.get(activeId)?.openDevtools()}
        >
          ⌘ DevTools
        </button>
        <button
          className="browser-btn"
          title="Open in system browser"
          onClick={() => window.open(activeTab?.current || HOME_URL, '_blank')}
        >
          ↗
        </button>
      </div>
      <div className={`browser-progress ${loading ? 'on' : ''}`} />
      {find.open && (
        <form
          className="browser-find"
          onSubmit={(e) => {
            e.preventDefault()
            submitFind((e.currentTarget.elements.namedItem('q') as HTMLInputElement).value)
          }}
        >
          <input
            name="q"
            autoFocus
            className="browser-find-input"
            placeholder="Find in page…"
            defaultValue={find.text}
            onChange={(e) => submitFind(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                // Plain Enter steps forward; Shift+Enter steps back.
                if (e.shiftKey) handles.current.get(activeId)?.findNext(false)
                else handles.current.get(activeId)?.findNext(true)
              }
            }}
          />
          <span
            className={`browser-find-count ${
              find.text && activeTab?.findMatches === 0 ? 'is-empty' : ''
            }`}
            title={
              !find.text
                ? 'Type to search'
                : activeTab?.findMatches === 0
                  ? 'No matches'
                  : `${activeTab?.findActive} of ${activeTab?.findMatches}`
            }
          >
            {!find.text
              ? ''
              : activeTab?.findMatches === 0
                ? 'No results'
                : `${activeTab?.findActive ?? 0} / ${activeTab?.findMatches}`}
          </span>
          <button
            type="button"
            className="browser-btn"
            title="Previous match (Shift+Enter)"
            disabled={!activeTab || activeTab.findMatches === 0}
            onClick={() => handles.current.get(activeId)?.findNext(false)}
          >
            ↑
          </button>
          <button
            type="button"
            className="browser-btn"
            title="Next match (Enter)"
            disabled={!activeTab || activeTab.findMatches === 0}
            onClick={() => handles.current.get(activeId)?.findNext(true)}
          >
            ↓
          </button>
          <button
            type="button"
            className="browser-btn"
            title="Close find bar"
            onClick={() => {
              setFind({ open: false, text: '' })
              handles.current.get(activeId)?.stopFind()
            }}
          >
            ✕
          </button>
        </form>
      )}
      <div className="browser-stack">
        {tabs.map((t) => (
          <div
            key={t.id}
            className="browser-view"
            style={{ display: t.id === activeId ? 'flex' : 'none' }}
          >
            <BrowserTab
              ref={(h) => {
                if (h) handles.current.set(t.id, h)
                else handles.current.delete(t.id)
              }}
              tab={t}
              onState={onState}
              onTitle={onTitle}
              onWebContents={onWebContents}
              onOpenTab={addTab}
            />
          </div>
        ))}
      </div>
      {dlDrawerOpen && (
        <div className="browser-dl-drawer">
          <div className="browser-dl-head">
            <span>Downloads</span>
            <span className="spacer" />
            <button className="ghost small" onClick={() => setDlDrawerOpen(false)}>
              ✕
            </button>
          </div>
          {downloads.length === 0 ? (
            <div className="browser-dl-empty">No downloads yet.</div>
          ) : (
            <ul className="browser-dl-list">
              {activeDownloads.map((d) => (
                <li key={d.id} className="browser-dl-row">
                  <span className="browser-dl-name" title={d.url}>
                    {d.filename}
                  </span>
                  <div className="browser-dl-bar">
                    <div
                      className="browser-dl-fill"
                      style={{
                        width: `${d.total > 0 ? Math.min(100, (d.received / d.total) * 100) : 0}%`
                      }}
                    />
                  </div>
                  <span className="browser-dl-status">
                    {d.total > 0
                      ? `${Math.round((d.received / d.total) * 100)}%`
                      : `${formatBytes(d.received)}`}
                  </span>
                  <button
                    className="ghost small"
                    onClick={() => void window.devterm.browserDownloads.cancel(d.id)}
                  >
                    Cancel
                  </button>
                </li>
              ))}
              {finishedDownloads.map((d) => (
                <li key={d.id} className={`browser-dl-row state-${d.state}`}>
                  <span className="browser-dl-name" title={d.url}>
                    {d.filename}
                  </span>
                  <span className="browser-dl-status">{d.state}</span>
                  <span className="browser-dl-spacer" />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

// Memoized like the terminal panes: a layout drag/resize tick must not re-render
// (and risk reloading) the embedded <webview>s; it only depends on its session.
export default memo(BrowserPane)
