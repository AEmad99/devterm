import { useCallback, useEffect, useRef, useState } from 'react'
import type { PreviewAnnotation, PreviewAnnotationKind } from '@shared/types'
import type { Session } from '../../store/sessions'
import { askAgentAboutPreview } from '../../lib/agent-selection'
import Button from '../common/Button'

type Tool = PreviewAnnotationKind | 'select'

function newId(): string {
  return `ann-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

export default function PreviewOverlay({
  session,
  webContentsId,
  currentUrl
}: {
  session: Session
  webContentsId: number | null
  currentUrl?: string
}) {
  const [tool, setTool] = useState<Tool>('pin')
  const [anns, setAnns] = useState<PreviewAnnotation[]>([])
  const [draft, setDraft] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const overlayRef = useRef<HTMLDivElement | null>(null)
  const drag = useRef<{ x: number; y: number } | null>(null)

  useEffect(() => {
    void window.devterm.preview.loadAnnotations(session.id).then(setAnns)
  }, [session.id])

  const persist = useCallback(
    (next: PreviewAnnotation[]) => {
      setAnns(next)
      void window.devterm.preview.saveAnnotations(session.id, next)
    },
    [session.id]
  )

  const rel = (e: React.PointerEvent) => {
    const box = overlayRef.current?.getBoundingClientRect()
    if (!box || box.width <= 0 || box.height <= 0) return { x: 0, y: 0 }
    return {
      x: Math.max(0, Math.min(1, (e.clientX - box.left) / box.width)),
      y: Math.max(0, Math.min(1, (e.clientY - box.top) / box.height))
    }
  }

  const promptBody = (kind: PreviewAnnotationKind, fallback = ''): string | null => {
    const body = window.prompt(kind === 'pin' ? 'Pin comment' : 'Comment', fallback)
    return body == null ? null : body.slice(0, 4000)
  }

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    const p = rel(e)
    if (tool === 'select') return
    if (tool === 'pin' || tool === 'text') {
      const body = promptBody(tool)
      if (body == null) return
      persist([
        ...anns,
        {
          id: newId(),
          kind: tool,
          x: p.x,
          y: p.y,
          w: tool === 'text' ? 0.22 : 0,
          h: tool === 'text' ? 0.08 : 0,
          body,
          createdAt: Date.now()
        }
      ])
      return
    }
    drag.current = p
    setDraft({ x: p.x, y: p.y, w: 0, h: 0 })
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }

  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current) return
    const p = rel(e)
    const x = Math.min(drag.current.x, p.x)
    const y = Math.min(drag.current.y, p.y)
    setDraft({ x, y, w: Math.abs(p.x - drag.current.x), h: Math.abs(p.y - drag.current.y) })
  }

  const onPointerUp = () => {
    if (!drag.current || !draft) {
      drag.current = null
      setDraft(null)
      return
    }
    drag.current = null
    if (draft.w < 0.01 && draft.h < 0.01) {
      setDraft(null)
      return
    }
    const body = promptBody('rect')
    setDraft(null)
    if (body == null) return
    persist([...anns, { id: newId(), kind: 'rect', ...draft, body, createdAt: Date.now() }])
  }

  const send = async (withShot: boolean) => {
    const sourceId = session.preview?.sourceSessionId
    if (!sourceId) {
      return
    }
    setBusy(true)
    try {
      let screenshotPath: string | undefined
      if (withShot && webContentsId != null) {
        screenshotPath = await window.devterm.preview.capture(webContentsId)
      }
      await askAgentAboutPreview({
        sourceSessionId: sourceId,
        previewTitle: session.title || 'Preview',
        url: currentUrl,
        comments: anns,
        screenshotPath
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="preview-toolbar">
        <span className="preview-toolbar-label">Preview</span>
        {(['select', 'pin', 'rect', 'text'] as const).map((t) => (
          <button
            key={t}
            type="button"
            className={`preview-tool ${tool === t ? 'is-active' : ''}`}
            onClick={() => setTool(t)}
          >
            {t === 'select' ? 'Browse' : t === 'pin' ? 'Pin' : t === 'rect' ? 'Rectangle' : 'Text'}
          </button>
        ))}
        <span className="spacer" />
        <Button
          className="ghost small"
          disabled={busy || !session.preview?.sourceSessionId}
          onClick={() => void send(false)}
        >
          Send comments
        </Button>
        <Button
          className="ghost small"
          disabled={busy || !session.preview?.sourceSessionId || webContentsId == null}
          onClick={() => void send(true)}
        >
          Send + screenshot
        </Button>
      </div>
      <div
        ref={overlayRef}
        className={`preview-overlay tool-${tool}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        {anns.map((a) => (
          <div
            key={a.id}
            className={`preview-ann preview-ann-${a.kind}`}
            style={{
              left: `${a.x * 100}%`,
              top: `${a.y * 100}%`,
              width: a.kind === 'rect' ? `${a.w * 100}%` : undefined,
              height: a.kind === 'rect' ? `${a.h * 100}%` : undefined
            }}
            title={a.body}
            onClick={(e) => {
              e.stopPropagation()
              const next = window.prompt('Edit comment', a.body)
              if (next == null) return
              persist(anns.map((x) => (x.id === a.id ? { ...x, body: next.slice(0, 4000) } : x)))
            }}
            onContextMenu={(e) => {
              e.preventDefault()
              e.stopPropagation()
              persist(anns.filter((x) => x.id !== a.id))
            }}
          >
            {a.kind !== 'rect' && <span className="preview-ann-body">{a.body || '•'}</span>}
          </div>
        ))}
        {draft && (
          <div
            className="preview-ann preview-ann-rect is-draft"
            style={{
              left: `${draft.x * 100}%`,
              top: `${draft.y * 100}%`,
              width: `${draft.w * 100}%`,
              height: `${draft.h * 100}%`
            }}
          />
        )}
      </div>
    </>
  )
}
