import { useEffect, useState } from 'react'
import type { Snippet } from '@shared/types'
import { runInActive } from '../lib/input'
import { applyPlaceholders, extractPlaceholders } from '../lib/snippets'
import SnippetForm from './SnippetForm'
import { IconKeyboard, IconPlus, IconConnect, IconEdit, IconTrash } from './Icons'

/**
 * Full-pane manager for saved command snippets — its own top-level tab. Lists
 * snippets with run / insert / edit / delete and opens SnippetForm for add/edit.
 * Plain snippets run straight into the active terminal; parameterised ones (with
 * {{placeholders}}) pop a small prompt for their values, then run/insert.
 */
export default function SnippetsManager({ onRun }: { onRun?: () => void }) {
  const [list, setList] = useState<Snippet[]>([])
  const [editing, setEditing] = useState<Snippet | null>(null)
  const [creating, setCreating] = useState(false)
  // A parameterised snippet awaiting placeholder values before it runs/inserts.
  const [params, setParams] = useState<Snippet | null>(null)
  const [values, setValues] = useState<Record<string, string>>({})

  const refresh = () => window.devterm.snippets.list().then(setList)
  useEffect(() => {
    refresh()
  }, [])

  const del = async (id: string) => setList(await window.devterm.snippets.delete(id))

  // Send a fully-resolved command to the active terminal, or warn if there's none.
  const dispatch = (command: string, execute: boolean) => {
    onRun?.()
    if (!runInActive(command, execute)) alert('No active terminal to send the command to.')
  }

  const run = (s: Snippet, execute: boolean) => {
    if (extractPlaceholders(s.command).length > 0) {
      setParams(s) // collect {{placeholder}} values first
      setValues({})
      return
    }
    dispatch(s.command, execute)
  }

  const submitParams = (execute: boolean) => {
    if (!params) return
    const command = applyPlaceholders(params.command, values)
    setParams(null)
    dispatch(command, execute)
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
          to run a snippet or pick from your recent commands.
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

      {params && (
        <div className="modal-backdrop" onClick={() => setParams(null)}>
          <form
            className="modal"
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault()
              submitParams(true)
            }}
          >
            <h3>{params.name}</h3>
            <div className="mr-sub sn-mono">{applyPlaceholders(params.command, values)}</div>
            <div className="palette-grid">
              {extractPlaceholders(params.command).map((name, i) => (
                <label key={name}>
                  {name}
                  <input
                    autoFocus={i === 0}
                    value={values[name] ?? ''}
                    onChange={(e) => setValues((v) => ({ ...v, [name]: e.target.value }))}
                  />
                </label>
              ))}
            </div>
            <div className="actions">
              <span className="spacer" />
              <button type="button" className="ghost" onClick={() => setParams(null)}>
                Cancel
              </button>
              <button type="button" onClick={() => submitParams(false)}>
                Insert
              </button>
              <button type="submit">Run</button>
            </div>
          </form>
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
