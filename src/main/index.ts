import {
  app,
  BrowserWindow,
  Menu,
  MenuItemConstructorOptions,
  clipboard,
  session,
  shell,
  dialog
} from 'electron'
import { join } from 'path'

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
import { registerPtyIpc } from './ipc/pty'
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
import { IPC } from '@shared/types'
import { initAutoUpdater } from './updater'
import type { PtyManager } from './pty/manager'
import type { SSHManager } from './ssh/manager'
import type { FileController } from './ipc/files'

let mainWindow: BrowserWindow | null = null
let ptyManager: PtyManager | null = null
let sshManager: SSHManager | null = null
let fileController: FileController | null = null
let agentController: AgentController | null = null

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
      // Enables the <webview> tag used by the in-app browser pane. Each guest is
      // hardened on attach (see web-contents-created below) and runs isolated.
      webviewTag: true
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  // Open external links in the OS browser, never in-app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
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
  registerFoundationIpc(() => mainWindow)
  registerGitIpc(sshManager, () => mainWindow)
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
              click: () => shell.openExternal(params.linkURL || params.pageURL)
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
    fileController?.transfers.cancelAll()
    ptyManager?.killAll()
    sshManager?.disconnectAll()
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => {
    agentController?.closeAll()
    fileController?.stopWatches()
    fileController?.transfers.cancelAll()
    ptyManager?.killAll()
    sshManager?.disconnectAll()
  })
}
