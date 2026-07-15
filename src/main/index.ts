import {
  BrowserWindow,
  Menu,
  MenuItemConstructorOptions,
  app,
  clipboard,
  dialog,
  ipcMain,
  session,
  shell
} from 'electron'
import { join } from 'path'

// Pin Chromium's disk cache, GPU shader cache, and service-worker storage
// inside the app's own userData directory before the cache subsystem
// initialises. Electron 29 on Windows defaults the cache to
// %LOCALAPPDATA%, which can be locked by antivirus, a zombie electron.exe
// from a previous dev run, or a freshly-migrated user data directory.
// When that happens Chromium logs a cascade of non-fatal startup errors:
//
//   cache_util_win.cc(20)]   Unable to move the cache: Access is denied. (0x5)
//   disk_cache.cc(208)]     Unable to create cache
//   gpu_disk_cache.cc(708)] Gpu Cache Creation failed: -2
//   service_worker_storage.cc(2016)] Failed to delete the database: Database IO error
//
// Pointing the cache at a subfolder of userData means we own its
// lifecycle: nothing outside the app holds a handle to it, on uninstall
// the data goes away with userData, and a stale lock can only come from
// ourselves (in which case quitting cleanly resolves it).
{
  // userData resolves from app.setName() / package.json name and is
  // available before `ready` on Electron 29.
  const userDataDir = app.getPath('userData')
  const cacheDir = join(userDataDir, 'Cache')
  const sessionDataDir = join(userDataDir, 'SessionData')
  app.setPath('cache', cacheDir)
  app.setPath('sessionData', sessionDataDir)
  // Belt-and-suspenders: the disk_cache backend also reads
  // --disk-cache-dir, so setting the same path on the command line keeps
  // disk_cache, the network cache, and the GPU shader cache consistent
  // even if Electron's defaults drift between versions.
  app.commandLine.appendSwitch('disk-cache-dir', cacheDir)
  // DevTerm is a terminal app, not a 3D one; the GPU shader disk cache
  // is the source of the "Gpu Cache Creation failed" line and has no
  // upside for us, so skip it.
  app.commandLine.appendSwitch('disable-gpu-shader-disk-cache')
}

// Electron 29 has a benign internal race around <webview> guests: when a page
// disposes a subframe mid-navigation (routine on Google and ad-heavy sites), an
// internal WebContents event handler can access the frame's WebFrameMain after
// it's been disposed and throw "Render frame was disposed before WebFrameMain
// could be accessed". The guest keeps working, but Electron's default handler
// pops a main-process error dialog. Swallow just that message; surface anything
// else through the same dialog so real crashes stay visible.
process.on('uncaughtException', (err) => {
  const msg = err instanceof Error ? err.message : String(err)
  if (msg.includes('Render frame was disposed before WebFrameMain could be accessed')) {
    return
  }
  // node-pty/ConPTY: when a TUI app or the shell exits, the conin pipe can close
  // with a write still in flight; the socket error surfaces here as an async
  // "write EPIPE" with no stack into our code. The pty is already gone and its
  // exit path cleans up, so a dialog can't help — log and move on.
  if ((err as NodeJS.ErrnoException).code === 'EPIPE') {
    console.warn('Ignored EPIPE from a closed pipe (pty/socket already gone):', msg)
    return
  }
  console.error('Uncaught exception in main process:', err)
  try {
    dialog.showErrorBox('A JavaScript error occurred in the main process', msg)
  } catch {
    /* dialog may be unavailable before app is ready */
  }
})
// Mirror uncaughtException for promise rejections. Newer Node defaults
// `--unhandled-rejections=throw`, which means a single async rejection in the
// MCP bridge / SSH manager / anywhere else can terminate the entire Electron
// main process and take every terminal and agent down with it. Swallow the
// same benign noise (EPIPE, disposed webframe) and surface the rest through
// the same error box so real failures stay visible.
process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason))
  const msg = err.message || String(reason)
  if (msg.includes('Render frame was disposed before WebFrameMain could be accessed')) {
    return
  }
  if ((err as NodeJS.ErrnoException).code === 'EPIPE') {
    console.warn('Ignored EPIPE rejection (pty/socket already gone):', msg)
    return
  }
  console.error('Unhandled promise rejection in main process:', err)
  try {
    dialog.showErrorBox('An async error occurred in the main process', msg)
  } catch {
    /* dialog may be unavailable before app is ready */
  }
})
import { registerPtyIpc } from './ipc/pty'
import { IPC } from '@shared/types'
import { globalSearchIndex } from './search/index'
import { registerSshIpc } from './ipc/ssh'
import { registerContextIpc } from './ipc/context'
import { registerFileIpc } from './ipc/files'
import { registerAgentIpc, type AgentController } from './ipc/agent'
import { registerConnectionsIpc } from './ipc/connections'
import { registerWorkspacesIpc } from './ipc/workspaces'
import { registerSnippetsIpc } from './ipc/snippets'
import { registerHistoryIpc } from './ipc/history'
import { registerDialogIpc } from './ipc/dialog'
import { registerClipboardIpc } from './ipc/clipboard'
import { registerWindowIpc } from './ipc/window'
import { registerFoundationIpc } from './foundation-ipc'
import { registerGitIpc } from './ipc/git'
import { registerTransfersIpc } from './ipc/transfers'
import { registerBrowserIpc } from './ipc/browser'
import { initAutoUpdater } from './updater'
import type { PtyManager } from './pty/manager'
import type { SSHManager } from './ssh/manager'
import type { FileController } from './ipc/files'

/**
 * Hand a URL to the OS browser only when it uses a safe web scheme. `window.open`
 * targets and guest link URLs are attacker-influenced; `shell.openExternal` will
 * happily dispatch `file://`, `smb://`, or custom protocol-handler URIs to the OS
 * (NTLM leaks via UNC paths, protocol-handler argument-injection RCE, etc.), so
 * allow only http/https/mailto through.
 */
function openExternalSafe(url: string | undefined): void {
  if (!url) return
  try {
    const { protocol } = new URL(url)
    if (protocol === 'http:' || protocol === 'https:' || protocol === 'mailto:') {
      void shell.openExternal(url)
    }
  } catch {
    /* not a parseable URL — ignore */
  }
}

let mainWindow: BrowserWindow | null = null
let ptyManager: PtyManager | null = null
let sshManager: SSHManager | null = null
let fileController: FileController | null = null
let agentController: AgentController | null = null
let transfersController: { shutdown: () => Promise<void> } | null = null
let browserController: { shutdown: () => Promise<void> } | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 500,
    show: false,
    // Use the normal OS window frame so Windows owns moving, resizing, Snap
    // Layouts, edge snapping, minimize/maximize/close, and system-menu behavior.
    frame: true,
    transparent: false,
    backgroundColor: '#16161e',
    title: 'DevTerm',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // Security baseline (§7.1): renderer is untrusted.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Let the attention chime (Web Audio) play without a prior user gesture.
      // An agent finishing isn't a gesture, so Chromium's default policy would
      // leave the AudioContext suspended and the chime silent. This is our own
      // trusted app shell, not arbitrary web content, so allowing it is fine.
      autoplayPolicy: 'no-user-gesture-required',
      // Don't suspend the renderer when the window is backgrounded. Attention
      // signals exist precisely for when you've switched away: the idle-detection
      // timers must keep ticking, and the Web Audio chime must keep playing. A
      // throttled/occluded window suspends its AudioContext (currentTime stops
      // advancing), so without this the chime is silent — and its volume slider
      // moot — in the one case it matters. Hidden terminals already pause their
      // own xterm rendering, so the residual cost is background timers, which a
      // terminal app (SSH keepalives, watches, transfers) wants alive anyway.
      backgroundThrottling: false,
      // Enables the <webview> tag used by the in-app browser pane. Each guest is
      // hardened on attach (see web-contents-created below) and runs isolated.
      webviewTag: true
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  // Stop the attention taskbar flash as soon as the operator comes back to the
  // window (Windows usually auto-clears on activate, but be explicit so a flash
  // can never get stuck on after focus returns).
  mainWindow.on('focus', () => mainWindow?.flashFrame(false))

  // Open external links in the OS browser, never in-app (and only safe schemes).
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafe(url)
    return { action: 'deny' }
  })

  // Lock the top frame to the app bundle. The main window's preload exposes the
  // full DevTerm bridge (SSH, SFTP, local fs read/write, clipboard, agent); if
  // the top frame were ever navigated away from our own document — a stray
  // `location =`, a dropped link, a future regression — that hostile page would
  // inherit the bridge. The in-app browser lives in an isolated <webview>, so
  // the app frame itself should never navigate anywhere but reload itself.
  const isAppUrl = (url: string): boolean => {
    if (process.env.ELECTRON_RENDERER_URL) return url.startsWith(process.env.ELECTRON_RENDERER_URL)
    return url.startsWith('file://')
  }
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (isAppUrl(url)) return
    e.preventDefault()
    openExternalSafe(url)
  })
  mainWindow.webContents.on('will-redirect', (e, url) => {
    if (!isAppUrl(url)) e.preventDefault()
  })

  // The app shell itself is trusted (unlike the <webview> browser pane, which is
  // default-denied above). Voice dictation captures the microphone via
  // getUserMedia from the renderer; without an explicit handler on the main
  // window's own session, packaged Electron silently denies the `media`
  // permission. Grant only `media` here; everything else falls through to
  // Chromium's defaults. Transcription runs fully locally (Whisper/WASM), so no
  // audio ever leaves the machine.
  mainWindow.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media')
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function registerIpc(): void {
  ptyManager = registerPtyIpc(() => mainWindow)
  sshManager = registerSshIpc(() => mainWindow)
  fileController = registerFileIpc(sshManager, () => mainWindow)
  agentController = registerAgentIpc(sshManager, ptyManager, () => mainWindow)
  registerConnectionsIpc()
  registerWorkspacesIpc()
  registerSnippetsIpc()
  registerHistoryIpc(sshManager)
  registerDialogIpc(() => mainWindow)
  registerClipboardIpc()
  registerWindowIpc(() => mainWindow)
  registerContextIpc()
  registerFoundationIpc(() => mainWindow, sshManager!)
  registerGitIpc(sshManager, () => mainWindow)
  // Cluster D: persistent transfer queue + in-app browser enhancements.
  transfersController = registerTransfersIpc(sshManager, () => mainWindow)
  browserController = registerBrowserIpc(() => mainWindow)

  // Global search handler (MVP)
  ipcMain.handle(IPC.searchQuery, (_e, q: string) => globalSearchIndex.query(q))
  ipcMain.handle(IPC.searchSeed, (_e, sessionId: string, lines: string[]) => {
    globalSearchIndex.seedLines(sessionId, lines, sessionId)
  })
}

// Headless self-test entrypoint: `electron . --self-test`.
if (process.argv.includes('--self-test')) {
  app.disableHardwareAcceleration()
  app.whenReady().then(async () => {
    const watchdog = setTimeout(() => {
      console.error('SELFTEST WATCHDOG: timed out after 90s')
      app.exit(3)
    }, 90000)
    const { runSelfTest } = await import('./selftest')
    const ok = await runSelfTest()
    clearTimeout(watchdog)
    app.exit(ok ? 0 : 1)
  })
} else {
  app.whenReady().then(() => {
    Menu.setApplicationMenu(null) // no default File/Edit/View menu — cleaner UI

    // Identify the app to Windows so attention notifications (Notification in
    // ipc/window.ts) are attributed to "DevTerm" with the app icon and group
    // under it in Action Center. Must match electron-builder's appId. No-op off
    // Windows. In dev (unpackaged) toasts may be limited, but the taskbar flash
    // still fires — packaged builds get full toast support via the install shim.
    app.setAppUserModelId('com.devterm.app')

    // The in-app browser pane's persistent partition (must match BrowserPane.tsx).
    // Strip the `DevTerm/x` and `Electron/x` tokens from its user agent so it looks
    // like plain desktop Chrome — Google (and other sign-in flows) otherwise flag the
    // embedded webview as an unsafe browser and refuse to let login complete.
    const browserSession = session.fromPartition('persist:browser')
    browserSession.setUserAgent(
      browserSession
        .getUserAgent()
        .replace(/ DevTerm\/[^ ]+/, '')
        .replace(/ Electron\/[^ ]+/, '')
    )

    // The browser pane loads arbitrary untrusted pages. Without a handler,
    // camera/mic/geolocation/notifications/USB/serial/HID prompts fall through to
    // Chromium defaults and surface attributed to "DevTerm". Default-deny the
    // sensitive ones; allow only the handful a normal browsing pane needs.
    const ALLOWED_PERMISSIONS = new Set(['fullscreen', 'clipboard-sanitized-write'])
    browserSession.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(ALLOWED_PERMISSIONS.has(permission))
    })
    browserSession.setPermissionCheckHandler((_wc, permission) =>
      ALLOWED_PERMISSIONS.has(permission)
    )
    // WebUSB / WebSerial / WebHID device access is never needed in the pane.
    browserSession.setDevicePermissionHandler(() => false)

    // Harden every <webview> guest (the browser pane loads untrusted web pages):
    // strip any preload + force node integration off on attach, and route the
    // guest's popups to the OS browser instead of letting it spawn in-app windows.
    app.on('web-contents-created', (_e, contents) => {
      contents.on('will-attach-webview', (_evt, webPreferences) => {
        delete webPreferences.preload
        webPreferences.nodeIntegration = false
      })
      if (contents.getType() === 'webview') {
        // A guest page opening a new window (target=_blank, window.open, "open in
        // new tab") becomes a new tab in the originating browser pane rather than an
        // OS-browser window — `contents.id` is the guest's webContents id, which the
        // renderer maps back to the right pane. Still deny the native popup window.
        contents.setWindowOpenHandler(({ url }) => {
          mainWindow?.webContents.send(IPC.browserOpenTab, { sourceId: contents.id, url })
          return { action: 'deny' }
        })
        // Keep guests on the web. A guest is meant for http(s) browsing, not for
        // reaching `file://`/`chrome://`/`devtools://` — those would let untrusted
        // web content read the local filesystem from a web origin. Allow http(s)
        // and about:blank; send anything else to the OS browser (if it's safe).
        const guestNavOk = (url: string): boolean =>
          /^https?:\/\//i.test(url) || url === 'about:blank'
        contents.on('will-navigate', (evt, url) => {
          if (guestNavOk(url)) return
          evt.preventDefault()
          openExternalSafe(url)
        })
        contents.on('will-redirect', (evt, url) => {
          if (!guestNavOk(url)) evt.preventDefault()
        })
        // The app has no application menu, so the guest gets no edit accelerators or
        // default context menu. Build one on right-click, driving the guest's own
        // WebContents (works regardless of focus) so copy/paste/cut and navigation work.
        contents.on('context-menu', (_evt, params) => {
          const { editFlags } = params
          const template: MenuItemConstructorOptions[] = [
            { label: 'Back', enabled: contents.canGoBack(), click: () => contents.goBack() },
            {
              label: 'Forward',
              enabled: contents.canGoForward(),
              click: () => contents.goForward()
            },
            { label: 'Reload', click: () => contents.reload() },
            { type: 'separator' },
            { label: 'Cut', enabled: editFlags.canCut, click: () => contents.cut() },
            {
              label: 'Copy',
              enabled: editFlags.canCopy || !!params.selectionText,
              click: () => contents.copy()
            },
            { label: 'Paste', enabled: editFlags.canPaste, click: () => contents.paste() },
            { label: 'Select All', click: () => contents.selectAll() }
          ]
          if (params.linkURL) {
            template.push(
              { type: 'separator' },
              { label: 'Copy Link Address', click: () => clipboard.writeText(params.linkURL) }
            )
          }
          template.push(
            { type: 'separator' },
            {
              label: 'Open in system browser',
              click: () => openExternalSafe(params.linkURL || params.pageURL)
            }
          )
          Menu.buildFromTemplate(template).popup()
        })
      }
    })
    registerIpc()
    createWindow()
    initAutoUpdater(() => mainWindow)
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    agentController?.closeAll()
    fileController?.stopWatches()
    // Cancel any in-flight persistent transfers. The persistent queue
    // already cancels in `before-quit`; doing it here too means a window
    // close without a quit (e.g. dock-quit on macOS) doesn't leak active
    // streams.
    void transfersController?.shutdown()
    ptyManager?.killAll()
    sshManager?.disconnectAll()
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => {
    agentController?.closeAll()
    fileController?.stopWatches()
    ptyManager?.killAll()
    sshManager?.disconnectAll()
    // Cluster D: persist the transfer queue and the browser zoom map.
    void transfersController?.shutdown()
    void browserController?.shutdown()
    // Optional persistent search tail (when search.persist is on).
    void flushPersistSearch()
  })
}

async function flushPersistSearch(): Promise<void> {
  // Imported here to avoid a circular import: search/index re-exports from
  // search/persist, and importing at the top pulls in `electron` early.
  const { flushPersist } = await import('./search')
  await flushPersist()
}
