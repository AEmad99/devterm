import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState
} from 'react'
import { useSessions, type Session } from '../store/sessions'
import { registerBrowserGuest } from '../lib/browserTabs'

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
}

function makeTab(url: string): TabState {
  return {
    id: newTabId(),
    initialUrl: url,
    title: 'New Tab',
    current: url,
    loading: false,
    canBack: false,
    canFwd: false
  }
}

/** Imperative surface the pane toolbar drives on the active tab. */
interface TabHandle {
  back(): void
  forward(): void
  reloadOrStop(): void
  loadURL(url: string): void
}

type StatePatch = Partial<Omit<TabState, 'id' | 'initialUrl' | 'title'>>

/**
 * One browser tab: an isolated, out-of-process Electron <webview> guest under the
 * shared persistent partition (so logins/cookies are shared across tabs and panes
 * and survive restarts). It stays mounted (display toggled by the parent) so its
 * page and scroll position survive tab switches; it reports nav/title changes up
 * and registers itself so main-process new-window requests land here as new tabs.
 */
const BrowserTab = memo(
  forwardRef<
    TabHandle,
    {
      tab: TabState
      onState: (id: string, patch: StatePatch) => void
      onTitle: (id: string, title: string) => void
      onOpenTab: (url: string) => void
    }
  >(function BrowserTab({ tab, onState, onTitle, onOpenTab }, ref) {
    const el = useRef<Electron.WebviewTag | null>(null)
    const loadingRef = useRef(false)

    useImperativeHandle(
      ref,
      () => ({
        back: () => el.current?.goBack(),
        forward: () => el.current?.goForward(),
        reloadOrStop: () => (loadingRef.current ? el.current?.stop() : el.current?.reload()),
        loadURL: (url: string) => el.current?.loadURL(url)
      }),
      []
    )

    useEffect(() => {
      const wv = el.current
      if (!wv) return
      const id = tab.id
      const setLoading = (v: boolean) => {
        loadingRef.current = v
        onState(id, { loading: v })
      }
      const refreshNav = () => onState(id, { canBack: wv.canGoBack(), canFwd: wv.canGoForward() })

      // No manual removeEventListener: the <webview> is destroyed when the tab
      // unmounts, so its listeners die with it (the app has no StrictMode, and
      // tab.id is stable for the tab's lifetime).
      wv.addEventListener('did-start-loading', () => setLoading(true))
      wv.addEventListener('did-stop-loading', () => {
        setLoading(false)
        refreshNav()
      })
      wv.addEventListener('did-navigate', (e) => {
        onState(id, { current: e.url })
        refreshNav()
      })
      wv.addEventListener('did-navigate-in-page', (e) => {
        if (e.isMainFrame) onState(id, { current: e.url })
      })
      wv.addEventListener('page-title-updated', (e) => onTitle(id, e.title || 'New Tab'))

      // Map this guest's webContents id → this pane's add-tab opener, so main can
      // route its new-window requests back here. Register once on first dom-ready
      // (the guest's webContents id is stable for the <webview>'s lifetime).
      let unregister = () => {}
      const onReady = () => {
        unregister()
        unregister = registerBrowserGuest(wv.getWebContentsId(), onOpenTab)
      }
      wv.addEventListener('dom-ready', onReady)
      return () => unregister()
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tab.id])

    return (
      <webview
        ref={el}
        className="browser-webview"
        src={tab.initialUrl}
        partition="persist:browser"
      />
    )
  })
)

/**
 * In-app browser pane with multiple tabs. The pane is a single layout leaf (one
 * `kind:'browser'` session); tabs live inside it. Open more panes for separate
 * "windows" — they share the persistent partition, so logins carry across both.
 */
function BrowserPane({ session }: { session: Session }) {
  const [tabs, setTabs] = useState<TabState[]>(() => [makeTab(session.url ?? HOME_URL)])
  const [activeId, setActiveId] = useState(tabs[0].id)
  const [address, setAddress] = useState(tabs[0].current)
  const handles = useRef(new Map<string, TabHandle>())
  const activeRef = useRef(activeId)
  activeRef.current = activeId

  const onState = useCallback((id: string, patch: StatePatch) => {
    setTabs((ts) => ts.map((t) => (t.id === id ? { ...t, ...patch } : t)))
    if (id === activeRef.current && patch.current !== undefined) setAddress(patch.current)
  }, [])

  const onTitle = useCallback((id: string, title: string) => {
    setTabs((ts) => ts.map((t) => (t.id === id ? { ...t, title } : t)))
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

  return (
    <div className="browser-pane">
      <div className="browser-tabs">
        {tabs.map((t) => (
          <div
            key={t.id}
            className={`browser-tab ${t.id === activeId ? 'active' : ''}`}
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
            placeholder="Search or enter address"
            onChange={(e) => setAddress(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
          />
        </form>
        <button
          className="browser-btn"
          title="Open in system browser"
          onClick={() => window.open(activeTab?.current || HOME_URL, '_blank')}
        >
          ↗
        </button>
      </div>
      <div className={`browser-progress ${loading ? 'on' : ''}`} />
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
              onOpenTab={addTab}
            />
          </div>
        ))}
      </div>
    </div>
  )
}

// Memoized like the terminal panes: a layout drag/resize tick must not re-render
// (and risk reloading) the embedded <webview>s; it only depends on its session.
export default memo(BrowserPane)
