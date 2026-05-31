import { useState } from 'react'
import type { Snippet } from '@shared/types'

interface FormState {
  name: string
  command: string
  description: string
  tags: string
}

const EMPTY: FormState = { name: '', command: '', description: '', tags: '' }

function fromSnippet(s: Snippet): FormState {
  return {
    name: s.name,
    command: s.command,
    description: s.description ?? '',
    tags: (s.tags ?? []).join(', ')
  }
}

export default function SnippetForm({
  initial,
  onSaved,
  onClose
}: {
  initial?: Snippet
  onSaved: (list: Snippet[]) => void
  onClose: () => void
}) {
  const [f, setF] = useState<FormState>(initial ? fromSnippet(initial) : EMPTY)

  const set =
    (k: keyof FormState) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setF((p) => ({ ...p, [k]: e.target.value }))

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const command = f.command.trim()
    if (!command) return
    const snippet: Snippet = {
      id: initial?.id || '',
      name: f.name.trim() || command,
      command,
      description: f.description.trim() || undefined,
      tags: f.tags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
    }
    onSaved(await window.devterm.snippets.save(snippet))
    onClose()
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h3>{initial ? 'Edit snippet' : 'New snippet'}</h3>

        <label>
          Name
          <input value={f.name} onChange={set('name')} placeholder="Restart nginx" autoFocus />
        </label>
        <label>
          Command
          <textarea
            className="sn-command"
            value={f.command}
            onChange={set('command')}
            rows={3}
            placeholder="sudo systemctl restart {{service}}"
          />
        </label>
        <div className="sn-hint">
          Use <code>{'{{token}}'}</code> placeholders — you’ll be prompted for them when the snippet
          runs from the palette.
        </div>
        <label>
          Description <span className="sn-opt">(optional)</span>
          <input value={f.description} onChange={set('description')} />
        </label>
        <label>
          Tags <span className="sn-opt">(comma-separated)</span>
          <input value={f.tags} onChange={set('tags')} placeholder="nginx, ops" />
        </label>

        <div className="actions">
          <span className="spacer" />
          <button type="button" className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit">Save</button>
        </div>
      </form>
    </div>
  )
}
