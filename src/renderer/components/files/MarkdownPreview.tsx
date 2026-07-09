import { useCallback, useEffect, useRef, useState } from 'react'
import { useDebouncedCallback } from '../../lib/debounce'
import { renderMarkdownToSafeHtml } from '../../lib/markdown-preview'
import type { EditorScope } from '../../store/editors'

interface MarkdownPreviewProps {
  docId: string
  content: string
  previewMode: 'edit' | 'side' | 'preview'
  scope: EditorScope
  path: string
  sessionId?: string
}

export default function MarkdownPreview({ docId, content, previewMode }: MarkdownPreviewProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  const prevIdentity = useRef({ docId, previewMode })

  const apply = useCallback((source: string) => {
    try {
      const html = renderMarkdownToSafeHtml(source)
      setError(null)
      const el = containerRef.current
      if (!el) return
      const top = el.scrollTop
      const left = el.scrollLeft
      el.innerHTML = html
      el.scrollTop = top
      el.scrollLeft = left
    } catch (e) {
      setError(String((e as Error).message || e))
    }
  }, [])

  const debouncedApply = useDebouncedCallback((source: string) => apply(source), 200)

  useEffect(() => {
    const identityChanged =
      prevIdentity.current.docId !== docId || prevIdentity.current.previewMode !== previewMode
    prevIdentity.current = { docId, previewMode }

    if (identityChanged) {
      debouncedApply.cancel()
      apply(content)
    } else {
      debouncedApply(content)
    }
  }, [content, docId, previewMode, apply, debouncedApply])

  const handleClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const anchor = (e.target as HTMLElement).closest('a') as HTMLAnchorElement | null
    if (!anchor) return

    const href = anchor.getAttribute('href')
    if (!href) {
      e.preventDefault()
      return
    }

    if (/^(https?:|mailto:)/i.test(href)) {
      e.preventDefault()
      void window.devterm.openExternal(href)
      return
    }

    if (href.startsWith('#')) {
      e.preventDefault()
      const id = href.slice(1)
      const el = id ? containerRef.current?.querySelector(`[id="${CSS.escape(id)}"]`) : null
      if (el) el.scrollIntoView({ behavior: 'auto', block: 'start' })
      return
    }

    e.preventDefault()
  }, [])

  if (error) {
    return (
      <div className="md-preview md-preview--error">
        <strong>Preview error</strong>
        <div>{error}</div>
      </div>
    )
  }

  if (!content.trim()) {
    return <div className="md-preview md-preview--empty">Nothing to preview</div>
  }

  return (
    <div
      ref={containerRef}
      className="md-preview"
      onClick={handleClick}
      aria-live="polite"
      aria-label="Markdown preview"
    />
  )
}
