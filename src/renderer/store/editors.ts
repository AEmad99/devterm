import { create } from 'zustand'
import type { FileContent } from '@shared/types'
import { isMarkdownName, nextMarkdownPreviewMode } from '../lib/markdown-preview'

export type EditorScope = 'local' | 'remote'
export type MarkdownPreviewMode = 'edit' | 'side' | 'preview'

export interface EditorDoc {
  /** Stable key: scope + sessionId + path. */
  id: string
  scope: EditorScope
  /** Present for remote docs; identifies the SSH session/SFTP channel. */
  sessionId?: string
  path: string
  /** Basename for the tab label. */
  name: string
  state: 'loading' | 'ready' | 'error'
  error?: string
  /** Current editor text (LF-normalized). */
  content: string
  /** Last-saved text (LF-normalized) — dirty = content !== savedContent. */
  savedContent: string
  /** Original EOL style, reapplied on save. */
  eol: '\n' | '\r\n'
  mtimeMs: number
  saving: boolean
  /** Only meaningful for Markdown files; default 'edit'. */
  previewMode?: MarkdownPreviewMode
}

export interface OpenTarget {
  scope: EditorScope
  sessionId?: string
  path: string
}

function basename(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean)
  return parts[parts.length - 1] || path
}

function docId(t: OpenTarget): string {
  return `${t.scope}:${t.sessionId ?? ''}:${t.path}`
}

function normalize(s: string): string {
  return s.replace(/\r\n/g, '\n')
}

function read(t: OpenTarget): Promise<FileContent> {
  return t.scope === 'remote'
    ? window.devterm.sftp.readFile(t.sessionId!, t.path)
    : window.devterm.fs.readFile(t.path)
}

function write(doc: EditorDoc, content: string): Promise<{ mtimeMs: number; size: number }> {
  return doc.scope === 'remote'
    ? window.devterm.sftp.writeFile(doc.sessionId!, doc.path, content)
    : window.devterm.fs.writeFile(doc.path, content)
}

interface EditorState {
  docs: EditorDoc[]
  activeId: string | null
  /** Whether the editor area (vs the active session) currently has focus. */
  focused: boolean
  open: (t: OpenTarget) => void
  close: (id: string) => void
  setActive: (id: string) => void
  /** Hand focus back to the session view (e.g. a terminal tab was clicked). */
  blur: () => void
  setContent: (id: string, content: string) => void
  setPreviewMode: (id: string, mode: MarkdownPreviewMode) => void
  /** Cycle Edit → Side → Preview for Markdown docs; no-op otherwise. */
  cyclePreviewMode: (id: string) => void
  save: (id: string) => Promise<void>
  /** Drop any docs belonging to a session that is closing/disconnecting. */
  closeForSession: (sessionId: string) => void
}

export const useEditors = create<EditorState>((set, get) => ({
  docs: [],
  activeId: null,
  focused: false,

  open: (t) => {
    const id = docId(t)
    const existing = get().docs.find((d) => d.id === id)
    if (existing) {
      set({ activeId: id, focused: true })
      return
    }
    const doc: EditorDoc = {
      id,
      scope: t.scope,
      sessionId: t.sessionId,
      path: t.path,
      name: basename(t.path),
      state: 'loading',
      content: '',
      savedContent: '',
      eol: '\n',
      mtimeMs: 0,
      saving: false,
      previewMode: 'edit'
    }
    set((s) => ({ docs: [...s.docs, doc], activeId: id, focused: true }))
    read(t)
      .then((fc) => {
        const content = normalize(fc.content)
        set((s) => ({
          docs: s.docs.map((d) =>
            d.id === id
              ? {
                  ...d,
                  state: 'ready',
                  content,
                  savedContent: content,
                  eol: fc.eol,
                  mtimeMs: fc.mtimeMs
                }
              : d
          )
        }))
      })
      .catch((e: unknown) => {
        set((s) => ({
          docs: s.docs.map((d) =>
            d.id === id ? { ...d, state: 'error', error: String((e as Error).message || e) } : d
          )
        }))
      })
  },

  close: (id) =>
    set((s) => {
      const docs = s.docs.filter((d) => d.id !== id)
      let activeId = s.activeId
      let focused = s.focused
      if (s.activeId === id) {
        activeId = docs.length ? docs[docs.length - 1].id : null
        if (!docs.length) focused = false
      }
      return { docs, activeId, focused }
    }),

  setActive: (id) => set({ activeId: id, focused: true }),
  blur: () => set({ focused: false }),

  setContent: (id, content) =>
    set((s) => ({ docs: s.docs.map((d) => (d.id === id ? { ...d, content } : d)) })),

  setPreviewMode: (id, mode) =>
    set((s) => ({ docs: s.docs.map((d) => (d.id === id ? { ...d, previewMode: mode } : d)) })),

  cyclePreviewMode: (id) => {
    const doc = get().docs.find((d) => d.id === id)
    if (!doc || !isMarkdownName(doc.name)) return
    get().setPreviewMode(id, nextMarkdownPreviewMode(doc.previewMode))
  },

  save: async (id) => {
    const doc = get().docs.find((d) => d.id === id)
    if (!doc || doc.state !== 'ready' || doc.saving) return
    if (doc.content === doc.savedContent) return
    set((s) => ({ docs: s.docs.map((d) => (d.id === id ? { ...d, saving: true } : d)) }))
    const onDisk = doc.eol === '\r\n' ? doc.content.replace(/\n/g, '\r\n') : doc.content
    try {
      // External-modification guard: no stat IPC exists, so re-read the file and
      // compare mtime against what we loaded. If the read fails we can't verify
      // — fall through and write (same behavior as before this guard).
      let freshMtime: number | null = null
      try {
        freshMtime = (await read(doc)).mtimeMs
      } catch {
        freshMtime = null
      }
      if (freshMtime !== null && doc.mtimeMs !== 0 && freshMtime !== doc.mtimeMs) {
        set((s) => ({
          docs: s.docs.map((d) =>
            d.id === id
              ? {
                  ...d,
                  saving: false,
                  error: 'file changed on disk since it was opened — not overwritten'
                }
              : d
          )
        }))
        return
      }
      const res = await write(doc, onDisk)
      set((s) => ({
        docs: s.docs.map((d) =>
          d.id === id
            ? {
                ...d,
                saving: false,
                savedContent: d.content,
                mtimeMs: res.mtimeMs,
                error: undefined
              }
            : d
        )
      }))
    } catch (e) {
      set((s) => ({
        docs: s.docs.map((d) =>
          d.id === id ? { ...d, saving: false, error: String((e as Error).message || e) } : d
        )
      }))
    }
  },

  closeForSession: (sessionId) =>
    set((s) => {
      const docs = s.docs.filter((d) => d.sessionId !== sessionId)
      if (docs.length === s.docs.length) return s
      const activeStillOpen = docs.some((d) => d.id === s.activeId)
      return {
        docs,
        activeId: activeStillOpen ? s.activeId : docs.length ? docs[docs.length - 1].id : null,
        focused: activeStillOpen ? s.focused : docs.length ? s.focused : false
      }
    })
}))
