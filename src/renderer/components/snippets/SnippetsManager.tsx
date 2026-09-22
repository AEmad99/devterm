import { useEffect, useMemo, useState } from 'react'
import type { Snippet } from '@shared/types'
import { runInActive } from '../../lib/input'
import { applyPlaceholders, extractPlaceholders } from '../../lib/snippets'
import { useSettings } from '../../store/settings'
import { toast } from '../../store/toasts'
import SnippetForm from './SnippetForm'
import ManagerList, { ManagerSkeleton } from '../common/ManagerList'
import ManagerRow from '../common/ManagerRow'
import Button from '../common/Button'
import {
  IconKeyboard,
  IconPlus,
  IconConnect,
  IconEdit,
  IconTrash,
  IconPin,
  IconArrowDown
} from '../common/Icons'

/**
 * Full-pane manager for saved command snippets — its own top-level tab. Lists
 * snippets with run / insert / edit / delete and opens SnippetForm for add/edit.
 * Plain snippets run straight into the active terminal; parameterised ones (with
 * {{placeholders}}) pop a small prompt for their values, then run/insert.
 */
export default function SnippetsManager({ onRun }: { onRun?: () => void }) {
  const pinned = useSettings((s) => s.pinned.snippets)
  const togglePin = useSettings((s) => s.togglePin)
  const [list, setList] = useState<Snippet[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<Snippet | null>(null)
  const [creating, setCreating] = useState(false)
  // A parameterised snippet awaiting placeholder values before it runs/inserts.
  const [params, setParams] = useState<Snippet | null>(null)
  const [values, setValues] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)

  const refresh = async () => {
    setList(await window.devterm.snippets.list())
    setLoading(false)
  }
  useEffect(() => {
    void refresh()
    return window.devterm.settingsIo.onImported(() => void refresh())
  }, [])

  const ordered = useMemo(() => {
    const pinIndex = new Map(pinned.map((id, i) => [id, i]))
    return [...list].sort((a, b) => {
      const pa = pinIndex.has(a.id) ? 0 : 1
      const pb = pinIndex.has(b.id) ? 0 : 1
      if (pa !== pb) return pa - pb
      if (pa === 0) return (pinIndex.get(a.id) ?? 0) - (pinIndex.get(b.id) ?? 0)
      return a.name.localeCompare(b.name)
    })
  }, [list, pinned])

  const del = async (s: Snippet) => {
    setList(await window.devterm.snippets.delete(s.id))
    toast(`Deleted “${s.name}”`, 'ok')
  }

  // Send a fully-resolved command to the active terminal, or warn if there's none.
  const dispatch = (command: string, execute: boolean) => {
    onRun?.()
    if (!runInActive(command, execute)) setError('No active terminal to send the command to.')
    else setError(null)
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
        <Button variant="primary" onClick={() => setCreating(true)}>
          <IconPlus size={15} />
          New snippet
        </Button>
      </div>

      {error && (
        <div className="palette-error" role="alert">
          {error}
        </div>
      )}

      {loading ? (
        <ManagerSkeleton />
      ) : list.length === 0 ? (
        <div className="manager-empty">
          No snippets yet. Press <kbd>Ctrl/Cmd+K</kbd> anywhere to run a snippet or pick from your
          recent commands.
          <div className="manager-empty-actions">
            <Button variant="primary" onClick={() => setCreating(true)}>
              <IconPlus size={15} />
              New snippet
            </Button>
          </div>
        </div>
      ) : (
        <ManagerList>
          {ordered.map((s) => {
            const isPinned = pinned.includes(s.id)
            return (
              <ManagerRow
                key={s.id}
                className={isPinned ? 'is-pinned' : ''}
                icon={<IconKeyboard size={19} />}
                title={s.name}
                subtitle={
                  <>
                    <span className="sn-mono">{s.command}</span>
                    {s.description && (
                      <>
                        <br />
                        {s.description}
                      </>
                    )}
                  </>
                }
                onDoubleClick={() => run(s, true)}
                actions={
                  <Button variant="primary" onClick={() => run(s, true)}>
                    <IconConnect size={14} />
                    Run
                  </Button>
                }
                secondaryActions={
                  <>
                    <Button
                      variant="icon"
                      active={isPinned}
                      onClick={() => togglePin('snippets', s.id)}
                      title={isPinned ? 'Unpin from top' : 'Pin to top'}
                      aria-label={isPinned ? `Unpin ${s.name}` : `Pin ${s.name}`}
                    >
                      <IconPin size={14} />
                    </Button>
                    <Button
                      title="Insert this snippet without running it"
                      onClick={() => run(s, false)}
                    >
                      <IconArrowDown size={14} />
                      <span className="btn-label">Insert</span>
                    </Button>
                    <Button title="Edit this snippet" onClick={() => setEditing(s)}>
                      <IconEdit size={14} />
                      <span className="btn-label">Edit</span>
                    </Button>
                    <Button variant="danger" title="Delete this snippet" onClick={() => del(s)}>
                      <IconTrash size={14} />
                      <span className="btn-label">Delete</span>
                    </Button>
                  </>
                }
              />
            )
          })}
        </ManagerList>
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
              <Button variant="ghost" onClick={() => setParams(null)}>
                Cancel
              </Button>
              <Button variant="ghost" onClick={() => submitParams(false)}>
                Insert
              </Button>
              <Button variant="primary" type="submit">
                Run
              </Button>
            </div>
          </form>
        </div>
      )}

      {(creating || editing) && (
        <SnippetForm
          initial={editing ?? undefined}
          onSaved={(next) => {
            setList(next)
            toast(editing ? 'Snippet saved' : 'Snippet created', 'ok')
          }}
          onClose={() => {
            setCreating(false)
            setEditing(null)
          }}
        />
      )}
    </div>
  )
}
