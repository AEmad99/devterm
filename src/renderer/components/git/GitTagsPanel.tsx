import { useEffect, useState } from 'react'
import type { GitCommandResult, GitTag } from '@shared/types'
import type { GitScope } from './GitPanel'
import { IconPlus, IconTrash } from '../common/Icons'
import ConfirmDialog from '../common/ConfirmDialog'

/**
 * The Tags tab — list of local tags with their target OID and (for annotated
 * tags) tagger + date. New + Delete actions live in the toolbar.
 */
export default function GitTagsPanel({
  scope,
  onNewTag,
  run,
  onError: _onError
}: {
  scope: GitScope
  onNewTag: () => void
  run: (
    op: () => Promise<GitCommandResult>,
    onError?: (r: GitCommandResult) => void
  ) => Promise<GitCommandResult | null>
  onError: (msg: string | null) => void
}) {
  const [tags, setTags] = useState<GitTag[] | null>(null)
  const [tick, setTick] = useState(0)
  const [busy, setBusy] = useState(false)
  // Tag name awaiting a delete confirmation.
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  useEffect(() => {
    void window.devterm.git.tags({ sessionId: scope.sessionId, path: scope.path }).then(setTags)
  }, [scope.path, scope.sessionId, tick])

  const deleteTag = async (name: string) => {
    setBusy(true)
    await run(() => window.devterm.git.tagDelete({ ...scope, names: [name] }))
    setBusy(false)
    setTick((x) => x + 1)
  }

  if (tags === null) return <div className="git-loading">loading…</div>
  if (tags.length === 0)
    return (
      <div className="git-empty">
        no tags
        <button className="git-mini" onClick={onNewTag} style={{ marginLeft: 8 }}>
          <IconPlus size={12} /> <span>Create</span>
        </button>
      </div>
    )

  return (
    <div className="git-section">
      <div className="git-section-head">
        <span className="git-section-title">Tags</span>
        <span className="git-section-count">{tags.length}</span>
        <span className="spacer" />
        <button className="git-mini" onClick={onNewTag}>
          <IconPlus size={12} />
          <span>New</span>
        </button>
      </div>
      <div className="git-section-body">
        {tags.map((t) => (
          <div key={t.name} className="git-tag-row">
            <span className="git-tag-name">{t.name}</span>
            <span className="git-meta git-sha" title={t.sha}>
              {t.sha.slice(0, 7)}
            </span>
            {t.annotated && <span className="git-pill">annotated</span>}
            {t.date && <span className="git-meta">{t.date.slice(0, 10)}</span>}
            <span className="spacer" />
            <button
              className="git-icon-btn small danger"
              disabled={busy}
              onClick={() => setConfirmDelete(t.name)}
              title="Delete tag"
              aria-label="Delete"
            >
              <IconTrash size={12} />
            </button>
          </div>
        ))}
      </div>

      {confirmDelete && (
        <ConfirmDialog
          open
          title="Delete tag?"
          message={
            <>
              Delete tag <b>{confirmDelete}</b>? This cannot be undone.
            </>
          }
          onConfirm={() => {
            void deleteTag(confirmDelete)
            setConfirmDelete(null)
          }}
          onClose={() => setConfirmDelete(null)}
        />
      )}
    </div>
  )
}
