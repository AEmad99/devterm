import type { Terminal } from '@xterm/xterm'

export interface Osc133Event {
  kind: 'A' | 'B' | 'C' | 'D'
  line: number
  x: number
}

export interface CommandBlock {
  id: string
  startLine: number
  inputLine: number
  inputX: number
  endLine: number
  command: string
  comment?: string
}

export interface BlockTrackerState {
  pending: {
    startLine: number
    inputLine?: number
    inputX?: number
    sawB: boolean
  } | null
  nextId: number
}

export function emptyBlockTracker(): BlockTrackerState {
  return { pending: null, nextId: 1 }
}

/**
 * A completed command is A then B, closed by the next prompt A.
 * C/D are ignored (no exit-code coloring until those markers exist).
 */
export function reduceOsc133(
  state: BlockTrackerState,
  event: Osc133Event
): { state: BlockTrackerState; completed: Omit<CommandBlock, 'command' | 'comment'> | null } {
  if (event.kind === 'B') {
    const pending = state.pending ?? { startLine: event.line, sawB: false }
    return {
      state: {
        ...state,
        pending: { ...pending, sawB: true, inputLine: event.line, inputX: event.x }
      },
      completed: null
    }
  }
  if (event.kind !== 'A') {
    return { state, completed: null }
  }
  let completed: Omit<CommandBlock, 'command' | 'comment'> | null = null
  if (state.pending?.sawB && state.pending.inputLine !== undefined) {
    completed = {
      id: `b${state.nextId}`,
      startLine: state.pending.startLine,
      inputLine: state.pending.inputLine,
      inputX: state.pending.inputX ?? 0,
      endLine: event.line
    }
  }
  return {
    state: {
      pending: { startLine: event.line, sawB: false },
      nextId: completed ? state.nextId + 1 : state.nextId
    },
    completed
  }
}

const COMMENTS_KEY = 'devterm.block-comments.v1'
const MAX_COMMENTS_PER_SESSION = 80

type CommentStore = Record<string, Record<string, { command: string; comment: string }>>

function readStore(): CommentStore {
  if (typeof localStorage === 'undefined') return {}
  try {
    const raw = localStorage.getItem(COMMENTS_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return {}
    return parsed as CommentStore
  } catch {
    return {}
  }
}

function writeStore(store: CommentStore): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(COMMENTS_KEY, JSON.stringify(store))
  } catch {
    /* storage full */
  }
}

export function commentKey(command: string): string {
  return command.replace(/\s+/g, ' ').trim().slice(0, 240)
}

export function saveBlockComment(sessionId: string, command: string, comment: string): void {
  const key = commentKey(command)
  if (!key) return
  const store = readStore()
  const session = { ...(store[sessionId] ?? {}) }
  const trimmed = comment.trim()
  if (!trimmed) delete session[key]
  else session[key] = { command: key, comment: trimmed }
  const keys = Object.keys(session)
  if (keys.length > MAX_COMMENTS_PER_SESSION) {
    for (const extra of keys.slice(0, keys.length - MAX_COMMENTS_PER_SESSION)) {
      delete session[extra]
    }
  }
  store[sessionId] = session
  writeStore(store)
}

export function loadBlockComment(sessionId: string, command: string): string | undefined {
  return readStore()[sessionId]?.[commentKey(command)]?.comment
}

export function commentsForPrompt(sessionId: string): string {
  const session = readStore()[sessionId]
  if (!session) return ''
  const rows = Object.values(session).filter((row) => row.comment.trim())
  if (!rows.length) return ''
  const body = rows
    .slice(-MAX_COMMENTS_PER_SESSION)
    .map((row) => `- \`${row.command}\`: ${row.comment}`)
    .join('\n')
  return `Operator comments on this pane:\n${body}`
}

function lineText(term: Terminal, line: number, startX = 0): string {
  try {
    return term.buffer.active.getLine(line)?.translateToString(true, startX) ?? ''
  } catch {
    return ''
  }
}

export function readBlockText(term: Terminal, startLine: number, endLine: number): string {
  const lines: string[] = []
  const last = Math.max(startLine, endLine)
  const first = Math.min(startLine, endLine)
  for (let i = first; i < last; i++) {
    const text = lineText(term, i)
    lines.push(text)
  }
  return lines.join('\n').replace(/\s+$/u, '')
}

export interface CommandBlocksController {
  handleOsc(kind: string): void
  hooksHealthy(): boolean
  atPrompt(): boolean
  dispose(): void
}

/**
 * Track OSC 133 A/B on a live xterm, paint faint gutters, and report hook health
 * for the optional command input editor.
 */
export function attachCommandBlocks(
  term: Terminal,
  _host: HTMLElement,
  opts: {
    sessionId: string
    onHooksChange: (healthy: boolean, atPrompt: boolean) => void
    onAskAgent: (text: string) => void
  }
): CommandBlocksController {
  let tracker = emptyBlockTracker()
  let healthy = false
  let atPrompt = false
  let disposed = false
  const decorations: Array<{ dispose: () => void }> = []
  let menuEl: HTMLDivElement | null = null

  const emitHooks = () => {
    if (disposed) return
    opts.onHooksChange(healthy, atPrompt)
  }

  const closeMenu = () => {
    if (!menuEl) return
    menuEl.remove()
    menuEl = null
  }

  const openMenu = (block: CommandBlock, x: number, y: number, text: string) => {
    closeMenu()
    const menu = document.createElement('div')
    menu.className = 'term-context-menu cmd-block-menu'
    menu.style.left = `${x}px`
    menu.style.top = `${y}px`
    menu.setAttribute('role', 'menu')
    const addItem = (label: string, onClick: () => void) => {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'term-context-menu-item'
      btn.textContent = label
      btn.addEventListener('click', () => {
        closeMenu()
        onClick()
      })
      menu.appendChild(btn)
    }
    addItem('Copy', () => {
      if (text) void window.devterm.clipboard.writeText(text)
    })
    addItem('Ask agent about this', () => {
      if (text) opts.onAskAgent(text)
    })
    const commentWrap = document.createElement('div')
    commentWrap.className = 'cmd-block-comment'
    const commentField = document.createElement('input')
    commentField.type = 'text'
    commentField.className = 'cmd-block-comment-input'
    commentField.placeholder = 'Comment this command…'
    commentField.value = block.comment ?? ''
    const saveBtn = document.createElement('button')
    saveBtn.type = 'button'
    saveBtn.className = 'term-context-menu-item'
    saveBtn.textContent = 'Save comment'
    saveBtn.addEventListener('click', () => {
      saveBlockComment(opts.sessionId, block.command, commentField.value)
      closeMenu()
    })
    commentField.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault()
        saveBlockComment(opts.sessionId, block.command, commentField.value)
        closeMenu()
      }
    })
    commentWrap.appendChild(commentField)
    commentWrap.appendChild(saveBtn)
    menu.appendChild(commentWrap)
    document.body.appendChild(menu)
    const rect = menu.getBoundingClientRect()
    if (rect.right > window.innerWidth) {
      menu.style.left = `${Math.max(4, x - (rect.right - window.innerWidth) - 4)}px`
    }
    if (rect.bottom > window.innerHeight) {
      menu.style.top = `${Math.max(4, y - (rect.bottom - window.innerHeight) - 4)}px`
    }
    menuEl = menu
  }

  const paintGutter = (block: CommandBlock) => {
    try {
      const marker = term.registerMarker(
        block.startLine - (term.buffer.active.baseY + term.buffer.active.cursorY)
      )
      if (!marker) return
      const decoration = term.registerDecoration({ marker })
      if (!decoration) {
        marker.dispose()
        return
      }
      decoration.onRender((el) => {
        el.classList.add('cmd-block-gutter')
        el.title = block.command ? `Command: ${block.command}` : 'Command block'
        el.onclick = (ev) => {
          ev.preventDefault()
          ev.stopPropagation()
          const comment = loadBlockComment(opts.sessionId, block.command)
          const text = readBlockText(term, block.startLine, block.endLine) || block.command
          openMenu({ ...block, comment }, ev.clientX, ev.clientY, text)
        }
      })
      decorations.push({
        dispose: () => {
          decoration.dispose()
          marker.dispose()
        }
      })
    } catch {
      /* proposed API / disposed terminal */
    }
  }

  const osc = term.parser.registerOscHandler(133, (data) => {
    const k = data[0]
    if (k !== 'A' && k !== 'B' && k !== 'C' && k !== 'D') return false
    const b = term.buffer.active
    const line = b.baseY + b.cursorY
    if (k === 'B') {
      healthy = true
      atPrompt = true
    } else if (k === 'C' || k === 'D') {
      atPrompt = false
    }
    const reduced = reduceOsc133(tracker, { kind: k, line, x: b.cursorX })
    tracker = reduced.state
    if (k === 'A') atPrompt = false
    if (reduced.completed) {
      const command = lineText(term, reduced.completed.inputLine, reduced.completed.inputX).trim()
      const block: CommandBlock = {
        ...reduced.completed,
        command,
        comment: loadBlockComment(opts.sessionId, command)
      }
      paintGutter(block)
    }
    emitHooks()
    return false
  })

  const onDocDown = (ev: MouseEvent) => {
    if (!menuEl) return
    if (ev.target instanceof Node && menuEl.contains(ev.target)) return
    closeMenu()
  }
  const onDocKey = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape') closeMenu()
  }
  document.addEventListener('mousedown', onDocDown, true)
  document.addEventListener('keydown', onDocKey)

  return {
    handleOsc: (kind: string) => {
      const k = kind[0]
      if (k !== 'A' && k !== 'B' && k !== 'C' && k !== 'D') return
      const b = term.buffer.active
      const reduced = reduceOsc133(tracker, {
        kind: k,
        line: b.baseY + b.cursorY,
        x: b.cursorX
      })
      tracker = reduced.state
    },
    hooksHealthy: () => healthy,
    atPrompt: () => atPrompt,
    dispose: () => {
      disposed = true
      osc.dispose()
      decorations.forEach((d) => d.dispose())
      decorations.length = 0
      document.removeEventListener('mousedown', onDocDown, true)
      document.removeEventListener('keydown', onDocKey)
      closeMenu()
    }
  }
}
