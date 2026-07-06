import { useMemo, useState } from 'react'
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

/**
 * Render the command with its `{{placeholder}}` tokens highlighted so the
 * author can see at a glance which fields will be prompted for at run time.
 * The visible text still contains the original tokens — we use spans only
 * for color, not for replacing characters.
 */
function PreviewCommand({ command }: { command: string }) {
  if (!command) return <span className="sn-preview-empty">—</span>
  // Split on `{{...}}` so each placeholder is wrapped in a span.
  const parts = command.split(/(\{\{[^}]+\}\})/g)
  return (
    <span className="sn-preview-cmd">
      {parts.map((p, i) =>
        p.startsWith('{{') ? (
          <span key={i} className="sn-preview-token">
            {p}
          </span>
        ) : (
          <span key={i}>{p}</span>
        )
      )}
    </span>
  )
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

  // The preview is the live command + the (trimmed) name. Placeholders are
  // highlighted; everything else is plain text. A short note under it tells
  // the author which tokens will prompt at run time.
  const placeholderCount = useMemo(
    () => (f.command.match(/\{\{[^}]+\}\}/g) ?? []).length,
    [f.command]
  )
  const previewName = f.name.trim() || (f.command.trim() ? f.command.trim().split(/\s+/, 1)[0] : '')

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
          Use <code>{'{{placeholders}}'}</code> like <code>{'{{host}}'}</code> for parameters.
        </div>
        <div className="sn-preview" aria-label="Live preview">
          <div className="sn-preview-label">Preview</div>
          <div className="sn-preview-name">
            {previewName || <span className="sn-preview-empty">—</span>}
          </div>
          <pre className="sn-preview-body">
            <PreviewCommand command={f.command} />
          </pre>
          {placeholderCount > 0 && (
            <div className="sn-preview-note">
              {placeholderCount} placeholder{placeholderCount === 1 ? '' : 's'} will be prompted
              when this snippet runs.
            </div>
          )}
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
