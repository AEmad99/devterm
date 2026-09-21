import type { PreviewKind, PreviewMeta, PreviewOpenRequest, PortForward } from '@shared/types'
import { useSessions } from '../store/sessions'
import { DEFAULT_GROUP, useLayout } from '../store/layout'
import { toast } from '../store/toasts'

/** Renderer-safe URL guard — preview stays on http(s) loopback/forwards. */
function previewUrlOk(raw: string): string | null {
  const s = raw.trim()
  if (!s) return null
  if (s === 'about:blank') return s
  if (/^https?:\/\//i.test(s)) return s
  if (/^localhost(:\d+)?(\/.*)?$/i.test(s)) return `http://${s}`
  if (/^127\.0\.0\.1(:\d+)?(\/.*)?$/i.test(s)) return `http://${s}`
  if (/^\d{2,5}$/.test(s)) return `http://127.0.0.1:${s}`
  const withScheme = /^[a-zA-Z0-9._\-:[\]%/]+$/.test(s) ? `http://${s}` : null
  if (withScheme && /^https?:\/\//i.test(withScheme)) return withScheme
  return null
}

export function localhostPreviewUrl(port: number): string {
  return `http://127.0.0.1:${port}/`
}

export async function openPreviewPane(opts: {
  kind: PreviewKind
  url?: string
  port?: number
  folderPath?: string
  sourceSessionId?: string
  title?: string
  groupId?: string
}): Promise<string | null> {
  let url = opts.url?.trim() || ''
  let serveId: string | undefined
  let port = opts.port
  if (opts.kind === 'folder') {
    if (!opts.folderPath) {
      toast('Choose a folder to preview.', 'err')
      return null
    }
    try {
      const served = await window.devterm.preview.serveFolder(opts.folderPath)
      url = served.url
      serveId = served.serveId
      port = served.port
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not serve that folder.', 'err')
      return null
    }
  } else if (opts.kind === 'localhost' || opts.kind === 'forward') {
    if (!url && port) url = localhostPreviewUrl(port)
  }
  const loadable = previewUrlOk(url)
  if (!loadable) {
    toast('Preview URLs must be http(s) on this machine or a forwarded port.', 'err')
    return null
  }

  const source = opts.sourceSessionId
    ? useSessions.getState().sessions.find((s) => s.id === opts.sourceSessionId)
    : useSessions.getState().sessions.find((s) => s.id === useSessions.getState().activeId)
  const groupId =
    opts.groupId ?? source?.groupId ?? useLayout.getState().activeGroupId ?? DEFAULT_GROUP
  const preview: PreviewMeta = {
    kind: opts.kind,
    sourceSessionId: source?.kind === 'browser' ? source.preview?.sourceSessionId : source?.id,
    port,
    folderPath: opts.folderPath,
    serveId
  }
  const title =
    opts.title ||
    (opts.kind === 'folder' ? `Preview ${opts.folderPath}` : port ? `Preview :${port}` : 'Preview')
  const paneId = useSessions.getState().addBrowser({
    url: loadable,
    groupId,
    preview,
    title
  })
  const live = useSessions.getState().sessions
  const layout = useLayout.getState()
  layout.sync(live.map((s) => ({ id: s.id, groupId: s.groupId })))
  if (source && source.id !== paneId) layout.splitBeside(source.id, paneId, 'right')
  useSessions.getState().setActive(paneId)
  return paneId
}

export async function listForwardedLocalPorts(sessionId: string): Promise<PortForward[]> {
  try {
    return (await window.devterm.portForward.list(sessionId)).filter((f) => f.kind === 'local')
  } catch {
    return []
  }
}

export function handlePreviewOpenRequest(req: PreviewOpenRequest): void {
  void (async () => {
    try {
      const paneId = await openPreviewPane({
        kind: req.folderPath ? 'folder' : 'localhost',
        url: req.url,
        folderPath: req.folderPath,
        sourceSessionId: req.ownerAgentSessionId,
        title: req.title,
        groupId: req.groupId
      })
      if (!paneId) {
        window.devterm.preview.ackOpen({
          requestId: req.requestId,
          error: 'Could not open preview'
        })
        return
      }
      const session = useSessions.getState().sessions.find((s) => s.id === paneId)
      window.devterm.preview.ackOpen({
        requestId: req.requestId,
        sessionId: paneId,
        url: session?.url
      })
    } catch (err) {
      window.devterm.preview.ackOpen({
        requestId: req.requestId,
        error: err instanceof Error ? err.message : String(err)
      })
    }
  })()
}

const portPanelListeners = new Set<(sessionId: string) => void>()

/** Ask the owning remote pane to show its port-forward panel. */
export function requestPortForwardPanel(sessionId: string): void {
  for (const listener of portPanelListeners) listener(sessionId)
}

export function onPortForwardPanelRequest(cb: (sessionId: string) => void): () => void {
  portPanelListeners.add(cb)
  return () => portPanelListeners.delete(cb)
}

let wired = false
export function initPreviewControl(): void {
  if (wired) return
  wired = true
  window.devterm.preview.onOpenRequest(handlePreviewOpenRequest)
}
