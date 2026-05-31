import { useEffect, useState } from 'react'
import type { Snippet } from '@shared/types'
import { runInActive } from '../lib/input'
import { extractPlaceholders } from '../lib/snippets'
import SnippetForm from './SnippetForm'
import { IconKeyboard, IconPlus, IconConnect, IconEdit, IconTrash } from './Icons'

/**
 * Full-pane manager for saved command snippets — its own top-level tab. Lists
 * snippets with run / insert / edit / delete and opens SnippetForm for add/edit.
 * Plain snippets run straight into the active terminal; parameterised ones (with
 * {{placeholders}}) are routed through the command palette (Ctrl/Cmd+K).
 */
export default function SnippetsManager({ onRun }: { onRun?: () => void }) {
  const [list, setList] = useState<Snippet[]>([])
  const [editing, setEditing] = useState<Snippet | null>(null)
  const [creating, setCreating] = useState(false)

  const refresh = () => window.devterm.snippets.list().then(setList)
  useEffect(() => {
    refresh()
  }, [])

  const del = async (id: string) => setList(await window.devterm.snippets.delete(id))

  const run = (s: Snippet, execute: boolean) => {
    if (extractPlaceholders(s.command).length > 0) {
      alert('This snippet has {{placeholders}} — run it from the command palette (Ctrl/Cmd+K).')
      return
    }
    onRun?.()
    if (!runInActive(s.command, execute)) alert('No active terminal to send the command to.')
  }

  return (
    <div className="manager">
      <div className="manager-head">
        <h2>Snippets</h2>
        <span className="spacer" />
        <button className="btn primary" onClick={() => setCreating(true)}>
          <IconPlus size={15} />
          New snippet
        </button>
      </div>

      {list.length === 0 ? (
        <div className="manager-empty">
          No snippets yet. Click “＋ New snippet” to add one. Press <kbd>Ctrl/Cmd+K</kbd> anywhere
          to run one in the active terminal.
        </div>
      ) : (
        <div className="manager-list">
          {list.map((s) => (
            <div key={s.id} className="manager-row">
              <div className="mr-icon">
                <IconKeyboard size={19} />
              </div>
              <div className="mr-main">
                <div className="mr-name">{s.name}</div>
                <div className="mr-sub sn-mono">{s.command}</div>
                {s.description && <div className="mr-sub">{s.description}</div>}
              </div>
              <div className="mr-actions">
                <button className="btn primary" onClick={() => run(s, true)}>
                  <IconConnect size={14} />
                  Run
                </button>
                <button className="btn" onClick={() => run(s, false)}>
                  Insert
                </button>
                <button className="btn" onClick={() => setEditing(s)}>
                  <IconEdit size={14} />
                  Edit
                </button>
                <button className="btn danger" onClick={() => del(s.id)}>
                  <IconTrash size={14} />
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {(creating || editing) && (
        <SnippetForm
          initial={editing ?? undefined}
          onSaved={setList}
          onClose={() => {
            setCreating(false)
            setEditing(null)
          }}
        />
      )}
    </div>
  )
}
