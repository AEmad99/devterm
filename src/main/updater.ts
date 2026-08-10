import { app, dialog, BrowserWindow, ipcMain } from 'electron'
import electronUpdater from 'electron-updater'
import { IPC, type AppUpdateCheckResult } from '@shared/types'

const { autoUpdater } = electronUpdater

/** True when background + manual update checks are allowed. */
function isUpdaterEnabled(): boolean {
  return !process.env.ELECTRON_RENDERER_URL && !process.argv.includes('--self-test')
}

/** Version reported by the last successful `update-downloaded` event, if any. */
let lastDownloadedVersion: string | null = null

/**
 * Wire up GitHub-Releases auto-update with a prompt-before-install flow:
 * the update downloads silently in the background, then we ask the user
 * whether to restart now or apply it on next quit. Builds are unsigned,
 * so signature verification is disabled in electron-builder.yml.
 */
export function initAutoUpdater(getWindow: () => BrowserWindow | null): void {
  // No update server in dev, and never during the headless self-test.
  if (!isUpdaterEnabled()) {
    return
  }

  // Download in the background; we control *when* it installs via the prompt.
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('error', (err) => {
    console.error('[updater] error:', err?.message ?? err)
  })

  autoUpdater.on('update-downloaded', async (info) => {
    lastDownloadedVersion = info.version
    const win = getWindow()
    const opts = {
      type: 'info' as const,
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update ready',
      message: `DevTerm ${info.version} is ready to install.`,
      detail:
        'Restart now to apply it, or it will be installed automatically the next time you quit.'
    }
    const { response } = win
      ? await dialog.showMessageBox(win, opts)
      : await dialog.showMessageBox(opts)
    if (response === 0) {
      // setImmediate gives the dialog time to close cleanly before quit.
      setImmediate(() => autoUpdater.quitAndInstall())
    }
  })

  app.whenReady().then(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      console.error('[updater] check failed:', err?.message ?? err)
    })
  })
}

/**
 * Manual update check for Settings → About. Safe to call repeatedly.
 * In dev / self-test returns `disabled` instead of hitting the network.
 */
export async function checkForUpdatesNow(): Promise<AppUpdateCheckResult> {
  const currentVersion = app.getVersion()

  if (!isUpdaterEnabled()) {
    return {
      status: 'disabled',
      currentVersion,
      message:
        'Update checks run in packaged installs only. Development and self-test builds skip the update server.'
    }
  }

  if (lastDownloadedVersion && lastDownloadedVersion !== currentVersion) {
    return {
      status: 'downloaded',
      currentVersion,
      latestVersion: lastDownloadedVersion,
      message: `DevTerm ${lastDownloadedVersion} is downloaded. Restart to install, or it will apply on next quit.`
    }
  }

  try {
    const result = await autoUpdater.checkForUpdates()
    if (!result?.updateInfo) {
      return {
        status: 'error',
        currentVersion,
        message: 'Update check returned no result. Check your network and try again.'
      }
    }

    const latestVersion = result.updateInfo.version

    // electron-updater sets downloadPromise when it starts fetching an update.
    if (result.downloadPromise) {
      return {
        status: 'available',
        currentVersion,
        latestVersion,
        message: `Version ${latestVersion} is available and downloading in the background. You will be prompted when it is ready.`
      }
    }

    if (latestVersion && latestVersion !== currentVersion) {
      // Update exists but download did not start (e.g. already in progress).
      return {
        status: 'available',
        currentVersion,
        latestVersion,
        message: `Version ${latestVersion} is available.`
      }
    }

    return {
      status: 'up-to-date',
      currentVersion,
      latestVersion: latestVersion || currentVersion,
      message: 'You are running the latest version.'
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[updater] manual check failed:', message)
    return {
      status: 'error',
      currentVersion,
      message: message || 'Update check failed.'
    }
  }
}

/** Register IPC for version display and manual update checks. */
export function registerUpdaterIpc(): void {
  ipcMain.handle(IPC.appGetVersion, (): string => app.getVersion())
  ipcMain.handle(IPC.appCheckForUpdates, (): Promise<AppUpdateCheckResult> => checkForUpdatesNow())
}
