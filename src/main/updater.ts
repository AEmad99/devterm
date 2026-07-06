import { app, dialog, BrowserWindow } from 'electron'
import electronUpdater from 'electron-updater'

const { autoUpdater } = electronUpdater

/**
 * Wire up GitHub-Releases auto-update with a prompt-before-install flow:
 * the update downloads silently in the background, then we ask the user
 * whether to restart now or apply it on next quit. Builds are unsigned,
 * so signature verification is disabled in electron-builder.yml.
 */
export function initAutoUpdater(getWindow: () => BrowserWindow | null): void {
  // No update server in dev, and never during the headless self-test.
  if (process.env.ELECTRON_RENDERER_URL || process.argv.includes('--self-test')) {
    return
  }

  // Download in the background; we control *when* it installs via the prompt.
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('error', (err) => {
    console.error('[updater] error:', err?.message ?? err)
  })

  autoUpdater.on('update-downloaded', async (info) => {
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
