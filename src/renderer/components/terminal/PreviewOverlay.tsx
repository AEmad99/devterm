import { useCallback, useEffect, useState, type PointerEvent } from 'react'
import { createPortal } from 'react-dom'
import type { PreviewAnnotation, PreviewAnnotationKind } from '@shared/types'
import type { Session } from '../../store/sessions'
import { askAgentAboutPreview } from '../../lib/agent-selection'
import Button from '../common/Button'

type Tool = PreviewAnnotationKind | 'select'

interface Composer {
  mode: 'create' | 'edit'
  id?: string
  kind: PreviewAnnotationKind
  x: number
  y: number
  w: number
  h: number
  body: string
}

function newId(): string {
  return `ann-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

const TOOLS: Array<{ id: Tool; label: string }> = [
  { id: 'select', label: 'Browse' },
  { id: 'pin', label: 'Pin' },
  { id: 'rect', label: 'Rectangle' },
  { id: 'text', label: 'Text' }
]

function commentTitle(kind: PreviewAnnotationKind): string {
  if (kind === 'pin') return 'Pin comment'
  if (kind === 'rect') return 'Rectangle comment'
  return 'Comment'
}

export default function PreviewOverlay({
  session,
  webContentsId,
  currentUrl,
  overlayRoot
}: {
  session: Session
  webContentsId: number | null
  currentUrl?: string
  /** The page stack. The drawing layer portals into it so it covers only the page. */
  overlayRoot: HTMLElement | null
}) {
  const [tool, setTool] = useState<Tool>('select')
  const [anns, setAnns] = useState<PreviewAnnotation[]>([])
  const [draft, setDraft] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null)
  const [composer, setComposer] = useState<Composer | null>(null)
  const [busy, setBusy] = useState(false)

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

  const rel = (e: PointerEvent) => {
    const box = overlayRoot?.getBoundingClientRect()
    if (!box || box.width <= 0 || box.height <= 0) return { x: 0, y: 0 }
    return {
      x: Math.max(0, Math.min(1, (e.clientX - box.left) / box.width)),
      y: Math.max(0, Math.min(1, (e.clientY - box.top) / box.height))
    }
  }

  const openComposer = (next: Composer) => setComposer(next)

  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0 || composer) return
    const p = rel(e)
    if (tool === 'select') return
    if (tool === 'pin' || tool === 'text') {
      openComposer({
        mode: 'create',
        kind: tool,
        x: p.x,
        y: p.y,
        w: tool === 'text' ? 0.22 : 0,
        h: tool === 'text' ? 0.08 : 0,
        body: ''
      })
      return
    }
    setDrag(p)
    setDraft({ x: p.x, y: p.y, w: 0, h: 0 })
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }

  const onPointerMove = (e: PointerEvent) => {
    if (!drag) return
    const p = rel(e)
    const x = Math.min(drag.x, p.x)
    const y = Math.min(drag.y, p.y)
    setDraft({ x, y, w: Math.abs(p.x - drag.x), h: Math.abs(p.y - drag.y) })
  }

  const onPointerUp = () => {
    if (!drag || !draft) {
      setDrag(null)
      setDraft(null)
      return
    }
    const drawn = draft
    setDrag(null)
    setDraft(null)
    if (drawn.w < 0.01 && drawn.h < 0.01) return
    openComposer({ mode: 'create', kind: 'rect', ...drawn, body: '' })
  }

  const saveComposer = () => {
    if (!composer) return
    const body = composer.body.slice(0, 4000)
    if (composer.mode === 'edit' && composer.id) {
      persist(anns.map((x) => (x.id === composer.id ? { ...x, body } : x)))
    } else if (body.trim()) {
      persist([
        ...anns,
        {
          id: newId(),
          kind: composer.kind,
          x: composer.x,
          y: composer.y,
          w: composer.w,
          h: composer.h,
          body,
          createdAt: Date.now()
        }
      ])
    }
    setComposer(null)
  }

  const send = async (withShot: boolean) => {
    const sourceId = session.preview?.sourceSessionId
    if (!sourceId) return
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

  const overlay = (
    <div
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
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          {a.kind === 'rect' ? (
            <span className="preview-ann-body preview-ann-rect-label">{a.body || 'Comment'}</span>
          ) : (
            <span className="preview-ann-body">{a.body || '•'}</span>
          )}
          <span className="preview-ann-actions">
            <button
              type="button"
              onClick={() =>
                openComposer({
                  mode: 'edit',
                  id: a.id,
                  kind: a.kind,
                  x: a.x,
                  y: a.y,
                  w: a.w,
                  h: a.h,
                  body: a.body
                })
              }
            >
              Edit
            </button>
            <button type="button" onClick={() => persist(anns.filter((x) => x.id !== a.id))}>
              Delete
            </button>
          </span>
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
      {composer && (
        <form
          className="preview-composer"
          onSubmit={(e) => {
            e.preventDefault()
            saveComposer()
          }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <label>
            {commentTitle(composer.kind)}
            <textarea
              autoFocus
              value={composer.body}
              maxLength={4000}
              onChange={(e) => setComposer({ ...composer, body: e.target.value })}
            />
          </label>
          <div className="preview-composer-actions">
            <Button type="button" variant="ghost" size="sm" onClick={() => setComposer(null)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" size="sm">
              Save
            </Button>
          </div>
        </form>
      )}
    </div>
  )

  return (
    <>
      <div className="preview-toolbar">
        <span className="preview-toolbar-label">Preview</span>
        {TOOLS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`preview-tool ${tool === t.id ? 'is-active' : ''}`}
            aria-pressed={tool === t.id}
            onClick={() => setTool(t.id)}
          >
            {t.label}
          </button>
        ))}
        <span className="spacer" />
        <Button
          className="ghost small"
          disabled={busy || !session.preview?.sourceSessionId}
          title={
            session.preview?.sourceSessionId
              ? 'Send these comments to the pane agent'
              : 'Open preview from a terminal so comments have an agent to reach'
          }
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
      {overlayRoot ? createPortal(overlay, overlayRoot) : null}
    </>
  )
}
