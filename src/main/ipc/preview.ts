import { app, BrowserWindow, ipcMain, webContents } from 'electron'
import { mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import {
  IPC,
  type PreviewAnnotation,
  type PreviewOpenAck,
  type PreviewOpenRequest,
  type PreviewServeResult
} from '@shared/types'
import { AnnotationStore } from '../preview/annotations'
import { startFolderServer, type FolderServe } from '../preview/static-server'

const pendingOpen = new Map<
  string,
  { resolve: (ack: PreviewOpenAck) => void; timer: ReturnType<typeof setTimeout> }
>()

export function registerPreviewIpc(getWindow: () => BrowserWindow | null): {
  requestOpen: (req: Omit<PreviewOpenRequest, 'requestId'> & { requestId?: string }) => Promise<PreviewOpenAck>
  shutdown: () => Promise<void>
} {
  const store = new AnnotationStore(app.getPath('userData'))
  const serves = new Map<string, FolderServe>()

  ipcMain.handle(IPC.previewServeFolder, async (_e, folderPath: string): Promise<PreviewServeResult> => {
    if (typeof folderPath !== 'string' || !folderPath.trim()) throw new Error('Folder path required')
    const serve = await startFolderServer(folderPath.trim())
    serves.set(serve.id, serve)
    return { serveId: serve.id, url: serve.url, port: serve.port }
  })

  ipcMain.handle(IPC.previewStopServe, async (_e, serveId: string) => {
    const serve = serves.get(serveId)
    if (!serve) return
    serves.delete(serveId)
    await serve.close()
  })

  ipcMain.handle(IPC.previewAnnotationsLoad, (_e, sessionId: string) => {
    if (typeof sessionId !== 'string') return []
    return store.load(sessionId)
  })

  ipcMain.handle(IPC.previewAnnotationsSave, (_e, sessionId: string, annotations: PreviewAnnotation[]) => {
    if (typeof sessionId !== 'string') throw new Error('sessionId required')
    return store.save(sessionId, Array.isArray(annotations) ? annotations : [])
  })

  ipcMain.handle(IPC.previewCapture, async (_e, webContentsId: number) => {
    const wc = webContents.fromId(Number(webContentsId))
    if (!wc || wc.isDestroyed()) throw new Error('Preview tab is gone')
    const img = await wc.capturePage()
    const png = img.toPNG()
    const dir = join(app.getPath('userData'), 'agent-artifacts')
    await mkdir(dir, { recursive: true })
    const file = join(dir, `preview-${Date.now()}.png`)
    await writeFile(file, png)
    return file
  })

  ipcMain.on(IPC.previewOpenAck, (_e, ack: PreviewOpenAck) => {
    const pending = ack?.requestId ? pendingOpen.get(ack.requestId) : undefined
    if (!pending) return
    clearTimeout(pending.timer)
    pendingOpen.delete(ack.requestId)
    pending.resolve(ack)
  })

  const requestOpen = (
    req: Omit<PreviewOpenRequest, 'requestId'> & { requestId?: string }
  ): Promise<PreviewOpenAck> => {
    const requestId = req.requestId ?? `preview-${Date.now()}`
    const payload: PreviewOpenRequest = { ...req, requestId }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingOpen.delete(requestId)
        resolve({ requestId, error: 'Timed out waiting for a preview pane' })
      }, 15000)
      pendingOpen.set(requestId, { resolve, timer })
      const win = getWindow()
      if (!win || win.isDestroyed()) {
        clearTimeout(timer)
        pendingOpen.delete(requestId)
        resolve({ requestId, error: 'Main window is not available' })
        return
      }
      win.webContents.send(IPC.previewOpenRequest, payload)
    })
  }

  return {
    requestOpen,
    shutdown: async () => {
      for (const serve of serves.values()) await serve.close().catch(() => undefined)
      serves.clear()
    }
  }
}

let previewController: ReturnType<typeof registerPreviewIpc> | null = null

export function previewIpc(): ReturnType<typeof registerPreviewIpc> | null {
  return previewController
}

export function setPreviewController(c: ReturnType<typeof registerPreviewIpc> | null): void {
  previewController = c
}
