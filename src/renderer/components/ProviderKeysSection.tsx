import { useCallback, useEffect, useState } from 'react'
import type { ProviderKeyInfo } from '@shared/types'

/**
 * Settings section: per-provider API key management.
 *
 * The plaintext is stored encrypted in main (`<userData>/provider-keys.json`,
 * safeStorage). Renderer only sees `id` + `isSet` — the field below is a
 * local `<input type="password">` cleared on save/close.
 *
 * No auto-save: a `Save` button commits the value so an accidental keystroke
 * doesn't clobber a working key. The `Remove` button clears the entry.
 */
export default function ProviderKeysSection({ busy }: { busy: boolean }) {
  const [keys, setKeys] = useState<ProviderKeyInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setKeys(await window.devterm.providerKeys.list())
    } catch (e) {
      setError(`Failed to load keys: ${(e as Error).message}`)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const beginEdit = (id: string) => {
    setEditingId(id)
    setDraft('')
    setError(null)
  }
  const cancelEdit = () => {
    setEditingId(null)
    setDraft('')
  }

  const save = async (id: string) => {
    if (!draft.trim()) return
    try {
      await window.devterm.providerKeys.set(id, draft.trim())
      setEditingId(null)
      setDraft('')
      setError(null)
      await refresh()
    } catch (e) {
      setError(`Save failed: ${(e as Error).message}`)
    }
  }
  const remove = async (id: string) => {
    try {
      await window.devterm.providerKeys.clear(id)
      setEditingId(null)
      setDraft('')
      setError(null)
      await refresh()
    } catch (e) {
      setError(`Remove failed: ${(e as Error).message}`)
    }
  }

  return (
    <section className="settings-section">
      <h3>Provider API keys</h3>
      <div className="settings-sub-hint">
        Encrypted at rest. Injected into the agent CLI&apos;s environment at launch — restart any
        open agent for a new key to take effect.
      </div>

      {loading ? (
        <div className="settings-row">
          <span className="settings-label">Loading…</span>
        </div>
      ) : (
        keys.map((k) => {
          const isEditing = editingId === k.id
          return (
            <div key={k.id} className="settings-row provider-key-row">
              <span className="settings-label">
                <span>{k.label}</span>
                <span className={`provider-key-badge ${k.isSet ? 'is-set' : 'is-unset'}`}>
                  {k.isSet ? 'Set' : 'Not set'}
                </span>
              </span>
              <span className="settings-control provider-key-control">
                {!isEditing && (
                  <>
                    <button
                      className="primary small"
                      disabled={busy}
                      onClick={() => beginEdit(k.id)}
                    >
                      {k.isSet ? 'Replace…' : 'Add…'}
                    </button>
                    {k.isSet && (
                      <button className="ghost small" disabled={busy} onClick={() => remove(k.id)}>
                        Remove
                      </button>
                    )}
                  </>
                )}
                {isEditing && (
                  <>
                    <input
                      autoFocus
                      type="password"
                      className="provider-key-input"
                      placeholder="paste API key"
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void save(k.id)
                        else if (e.key === 'Escape') cancelEdit()
                      }}
                    />
                    <button
                      className="primary small"
                      disabled={busy || !draft.trim()}
                      onClick={() => save(k.id)}
                    >
                      Save
                    </button>
                    <button className="ghost small" disabled={busy} onClick={cancelEdit}>
                      Cancel
                    </button>
                  </>
                )}
              </span>
              {k.hint && <div className="settings-sub-hint">{k.hint}</div>}
            </div>
          )
        })
      )}
      {error && <div className="settings-error">{error}</div>}
    </section>
  )
}
