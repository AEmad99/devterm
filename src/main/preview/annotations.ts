import { mkdir, readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import type { PreviewAnnotation, PreviewAnnotationKind } from '@shared/types'

const KINDS: PreviewAnnotationKind[] = ['pin', 'rect', 'text']

export function annotationFileName(sessionId: string): string {
  return sessionId.replace(/\.\./g, '_').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 180) || 'session'
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(1, n))
}

export function normalizeAnnotation(raw: unknown): PreviewAnnotation | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const id = typeof o.id === 'string' && o.id.trim() ? o.id.trim() : null
  const kind = KINDS.includes(o.kind as PreviewAnnotationKind)
    ? (o.kind as PreviewAnnotationKind)
    : null
  const body = typeof o.body === 'string' ? o.body.slice(0, 4000) : ''
  if (!id || !kind) return null
  const x = clamp01(Number(o.x))
  const y = clamp01(Number(o.y))
  const w = clamp01(Number(o.w))
  const h = clamp01(Number(o.h))
  return {
    id,
    kind,
    x,
    y,
    w: kind === 'pin' ? 0 : w,
    h: kind === 'pin' ? 0 : h,
    body,
    createdAt: typeof o.createdAt === 'number' && Number.isFinite(o.createdAt) ? o.createdAt : Date.now(),
    screenshotRef: typeof o.screenshotRef === 'string' ? o.screenshotRef : undefined
  }
}

export class AnnotationStore {
  constructor(private userData: string) {}

  private dir(): string {
    return join(this.userData, 'annotations')
  }

  private file(sessionId: string): string {
    return join(this.dir(), `${annotationFileName(sessionId)}.json`)
  }

  async load(sessionId: string): Promise<PreviewAnnotation[]> {
    try {
      const raw = JSON.parse(await readFile(this.file(sessionId), 'utf8')) as unknown
      const list = Array.isArray(raw) ? raw : (raw as { annotations?: unknown }).annotations
      if (!Array.isArray(list)) return []
      return list.map(normalizeAnnotation).filter((a): a is PreviewAnnotation => !!a)
    } catch {
      return []
    }
  }

  async save(sessionId: string, annotations: PreviewAnnotation[]): Promise<void> {
    await mkdir(this.dir(), { recursive: true })
    const cleaned = annotations.map(normalizeAnnotation).filter((a): a is PreviewAnnotation => !!a)
    await writeFile(this.file(sessionId), JSON.stringify(cleaned, null, 2), { encoding: 'utf8', mode: 0o600 })
  }
}
