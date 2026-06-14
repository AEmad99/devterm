import { promises as fs } from 'fs'
import { join } from 'path'
import type { BrowserZoomMap } from '@shared/types'

/**
 * Per-origin zoom level for the in-app browser. Persisted in
 * `userData/browser-zoom.json` (atomic write). The renderer's BrowserPane
 * calls `get(origin)` on `did-navigate` and applies `setZoomLevel` to the
 * <webview>; user-driven Ctrl+Plus/Minus/0 mutates via `set` / `reset`.
 *
 * Clamped to the [0.5, 3.0] range Electron supports on its webview.
 */
const MIN_ZOOM = 0.5
const MAX_ZOOM = 3.0
const DEFAULT_ZOOM = 1.0

export class BrowserZoomStore {
  private file: string
  private map: BrowserZoomMap = {}
  private writeTimer: NodeJS.Timeout | null = null

  constructor(userData: string) {
    this.file = join(userData, 'browser-zoom.json')
  }

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.file, 'utf-8')
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        this.map = {}
        for (const [k, v] of Object.entries(parsed)) {
          const n = Number(v)
          if (Number.isFinite(n) && n > 0) this.map[k] = clamp(n, MIN_ZOOM, MAX_ZOOM)
        }
      }
    } catch (e) {
      const err = e as NodeJS.ErrnoException
      if (err.code !== 'ENOENT') {
        console.warn('browser-zoom.json: failed to read, starting empty:', err.message)
      }
      this.map = {}
    }
  }

  get(origin: string): number {
    return this.map[origin] ?? DEFAULT_ZOOM
  }

  async set(origin: string, level: number): Promise<number> {
    const clamped = clamp(level, MIN_ZOOM, MAX_ZOOM)
    this.map[origin] = clamped
    this.scheduleFlush()
    return clamped
  }

  async reset(): Promise<void> {
    this.map = {}
    await this.flushNow()
  }

  private scheduleFlush(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer)
    }
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null
      void this.flushNow()
    }, 200)
  }

  async flushNow(): Promise<void> {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer)
      this.writeTimer = null
    }
    const tmp = this.file + '.tmp'
    try {
      await fs.mkdir(join(this.file, '..'), { recursive: true })
      await fs.writeFile(tmp, JSON.stringify(this.map, null, 2), 'utf-8')
      await fs.rename(tmp, this.file)
    } catch (e) {
      console.warn('browser-zoom.json: failed to persist:', (e as Error).message)
    }
  }
}

function clamp(n: number, lo: number, hi: number): number {
  if (n < lo) return lo
  if (n > hi) return hi
  return n
}
