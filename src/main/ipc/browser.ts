import {
  app,
  BrowserWindow,
  ipcMain,
  session as electronSession,
  shell,
  webContents
} from 'electron'
import type { DownloadItem } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { IPC, type BrowserDownloadItem } from '@shared/types'
import { BrowserZoomStore } from '../browser-zoom'

interface DownloadRecord {
  id: string
  item: DownloadItem
  rec: BrowserDownloadItem
}

/**
 * Register the in-app browser enhancements:
 *  - Downloads manager: hook `will-download` on the persistent `browser`
 *    session; expose a list/cancel API to the renderer.
 *  - Zoom store: per-origin level persisted in userData/browser-zoom.json.
 *  - DevTools + mute helpers: address by webContents id.
 *
 * The persistent `persist:browser` partition string is unchanged — we attach
 * to the SAME session main creates in `src/main/index.ts`.
 */
export function registerBrowserIpc(getWindow: () => BrowserWindow | null): {
  shutdown: () => Promise<void>
} {
  const userData = app.getPath('userData')
  const zoom = new BrowserZoomStore(userData)
  void zoom.load()

  // Each Electron DownloadItem owns a record we surface to the renderer.
  // Map<id, { item, rec }> keyed by our synthetic id.
  const records = new Map<string, DownloadRecord>()
  const send = (channel: string, ...args: unknown[]) => {
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
  }
  const listDownloads = (): BrowserDownloadItem[] =>
    Array.from(records.values())
      .map((r) => r.rec)
      .sort((a, b) => b.startedAt - a.startedAt)
  const broadcast = () => send(IPC.browserDownloadsEvent, listDownloads())
  let broadcastTimer: ReturnType<typeof setTimeout> | null = null
  const scheduleBroadcast = () => {
    if (broadcastTimer) clearTimeout(broadcastTimer)
    broadcastTimer = setTimeout(() => {
      broadcastTimer = null
      broadcast()
    }, 150)
  }

  function attach(): void {
    const sess = electronSession.fromPartition('persist:browser')
    // Avoid double-attaching if registerBrowserIpc is somehow called twice
    // (it isn't, but the test would be annoying to debug).
    if ((sess as unknown as { __devtermDlWired?: boolean }).__devtermDlWired) return

    sess.on('will-download', (_event, item) => {
      const defaultDir = join(userData, 'Downloads')
      const filename = item.getFilename() || 'download'
      // Uniquify so two same-name downloads don't clobber each other.
      const savePath = uniqueDownloadPath(defaultDir, filename)
      item.setSavePath(savePath)
      const id = synthId()
      const rec: BrowserDownloadItem = {
        id,
        filename,
        url: item.getURL(),
        path: savePath,
        received: 0,
        total: item.getTotalBytes(),
        state: 'progressing',
        startedAt: Date.now(),
        mime: item.getMimeType() || undefined
      }
      const record: DownloadRecord = { id, item, rec }
      records.set(id, record)
      broadcast()

      item.on('updated', () => {
        const newTotal = item.getTotalBytes()
        rec.received = item.getReceivedBytes()
        if (newTotal > 0) rec.total = newTotal
        rec.state = 'progressing'
        scheduleBroadcast()
      })
      item.on('done', (_e, state) => {
        rec.state = mapState(state)
        rec.received = item.getReceivedBytes()
        const finalTotal = item.getTotalBytes()
        if (finalTotal > 0) rec.total = finalTotal
        else if (rec.received > 0) rec.total = rec.received
        rec.path = item.getSavePath() || rec.path
        if (broadcastTimer) { clearTimeout(broadcastTimer); broadcastTimer = null }
        broadcast()
        if (rec.state === 'cancelled' || rec.state === 'interrupted') {
          records.delete(id)
        } else {
          setTimeout(() => { records.delete(id) }, 300_000)
        }
      })
    })
    ;(sess as unknown as { __devtermDlWired?: boolean }).__devtermDlWired = true
  }

  try {
    attach()
  } catch {
    setTimeout(attach, 250)
  }

  ipcMain.handle(IPC.browserDownloadsList, (): BrowserDownloadItem[] => listDownloads())
  ipcMain.handle(IPC.browserDownloadsCancel, (_e, id: string) => {
    const record = records.get(id)
    if (!record) return
    try {
      record.item.cancel()
    } catch {
      /* ignore — already gone */
    }
    record.rec.state = 'cancelled'
    broadcast()
  })

  ipcMain.handle(IPC.browserZoomGet, (_e, origin: string) => zoom.get(origin))
  ipcMain.handle(IPC.browserZoomSet, async (_e, origin: string, level: number) => {
    const clamped = await zoom.set(origin, level)
    webContents.getAllWebContents().forEach((wc) => {
      try {
        if (sameOrigin(wc.getURL(), origin)) wc.setZoomLevel(zoomLevelToElectron(clamped))
      } catch {
        /* ignore */
      }
    })
    return clamped
  })
  ipcMain.handle(IPC.browserZoomReset, async () => {
    await zoom.reset()
    webContents.getAllWebContents().forEach((wc) => {
      try {
        const url = wc.getURL()
        if (!url.startsWith('http://') && !url.startsWith('https://')) return
        wc.setZoomLevel(0)
      } catch {
        /* ignore */
      }
    })
  })

  ipcMain.handle(IPC.browserDevtoolsOpen, (_e, webContentsId: number) => {
    const wc = webContents.fromId(webContentsId)
    if (!wc) return
    wc.openDevTools({ mode: 'detach' })
  })
  ipcMain.handle(IPC.browserMute, (_e, webContentsId: number, muted: boolean) => {
    const wc = webContents.fromId(webContentsId)
    if (!wc) return
    wc.setAudioMuted(muted)
  })
  ipcMain.handle(IPC.browserOpenExternal, (_e, url: string) => {
    if (!url) return
    try {
      const { protocol } = new URL(url)
      if (protocol === 'http:' || protocol === 'https:' || protocol === 'mailto:') {
        void shell.openExternal(url)
      }
    } catch {
      /* ignore malformed URLs */
    }
  })

  return {
    shutdown: async () => {
      await zoom.flushNow()
    }
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function synthId(): string {
  return `dl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** `name.ext` → `name (1).ext`, `name (2).ext`, … until the path is free. */
function uniqueDownloadPath(dir: string, filename: string): string {
  let candidate = join(dir, filename)
  if (!existsSync(candidate)) return candidate
  const dot = filename.lastIndexOf('.')
  const base = dot > 0 ? filename.slice(0, dot) : filename
  const ext = dot > 0 ? filename.slice(dot) : ''
  for (let i = 1; ; i++) {
    candidate = join(dir, `${base} (${i})${ext}`)
    if (!existsSync(candidate)) return candidate
  }
}

function mapState(
  s: 'completed' | 'cancelled' | 'interrupted' | 'progressing'
): BrowserDownloadItem['state'] {
  if (s === 'completed') return 'completed'
  if (s === 'cancelled') return 'cancelled'
  if (s === 'interrupted') return 'interrupted'
  return 'progressing'
}

function sameOrigin(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === origin
  } catch {
    return false
  }
}

/** Electron's `setZoomLevel` uses a log(1.2) scale: level = ln(percent) / ln(1.2) */
function zoomLevelToElectron(percent: number): number {
  return Math.log(percent) / Math.log(1.2)
}
