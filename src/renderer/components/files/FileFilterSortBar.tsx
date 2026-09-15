import { useCallback, useState, type RefObject } from 'react'
import {
  FILE_SORT_KEYS,
  loadFileSortPrefs,
  saveFileSortPrefs,
  type FileSortKey,
  type FileSortPrefs
} from '../../lib/file-sort'
import { IconClose, IconSearch } from '../common/Icons'

/**
 * Persisted sort preferences shared by every file view. All panes read the
 * same localStorage key, so changing the sort in one view sticks everywhere.
 */
export function useFileSortPrefs(): [FileSortPrefs, (p: FileSortPrefs) => void] {
  const [prefs, setPrefs] = useState<FileSortPrefs>(() => loadFileSortPrefs())
  const update = useCallback((p: FileSortPrefs) => {
    setPrefs(p)
    saveFileSortPrefs(p)
  }, [])
  return [prefs, update]
}

/**
 * Filter-as-you-type + sort controls shared by the sidebar explorer and the
 * SFTP dual-pane browser. The parent owns the query string and the sort
 * prefs (via `useFileSortPrefs`) and applies the matching sort/filter
 * through `FileTree`'s props — this bar is presentation only.
 */
export default function FileFilterSortBar({
  query,
  onQueryChange,
  sort,
  onSortChange,
  total,
  shown,
  inputRef,
  onEnterFirst
}: {
  query: string
  onQueryChange: (q: string) => void
  sort: FileSortPrefs
  onSortChange: (p: FileSortPrefs) => void
  /** Entries in the folder before filtering. */
  total: number
  /** Entries in the folder after filtering. */
  shown: number
  // Nullable-parameterized: React 19's `useRef<HTMLInputElement>(null)` returns
  // `RefObject<HTMLInputElement | null>`, which the `ref` attribute accepts.
  inputRef?: RefObject<HTMLInputElement | null>
  /** Fired on Enter — the parent opens the first visible match. */
  onEnterFirst?: () => void
}) {
  const filtering = query.trim().length > 0
  const dirLabel = sort.dir === 'asc' ? 'ascending' : 'descending'
  return (
    <div className="ff-bar">
      <div className="ff-search">
        <IconSearch size={12} />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="Filter files…"
          spellCheck={false}
          aria-label="Filter files in this folder"
          title="Type to filter this folder ( / focuses)"
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              onEnterFirst?.()
            } else if (e.key === 'Escape') {
              // Esc clears first, then blurs — and never bubbles to a
              // parent overlay handler while the filter owns the keystroke.
              e.preventDefault()
              e.stopPropagation()
              if (query) onQueryChange('')
              else (e.target as HTMLInputElement).blur()
            }
          }}
        />
        {filtering && (
          <span className="ff-count" title="Matching files">
            {shown} of {total}
          </span>
        )}
        {filtering && (
          <button
            className="ff-btn"
            title="Clear filter (Esc)"
            aria-label="Clear filter"
            onClick={() => onQueryChange('')}
          >
            <IconClose size={12} />
          </button>
        )}
      </div>
      <div className="ff-sort">
        <select
          value={sort.key}
          onChange={(e) => onSortChange({ ...sort, key: e.target.value as FileSortKey })}
          title="Sort files by"
          aria-label="Sort files by"
        >
          {FILE_SORT_KEYS.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </select>
        <button
          className="ff-btn ff-dir"
          title={`Sort ${dirLabel} (click to reverse)`}
          aria-label={`Sort direction: ${dirLabel}. Activate to reverse.`}
          onClick={() => onSortChange({ ...sort, dir: sort.dir === 'asc' ? 'desc' : 'asc' })}
        >
          {sort.dir === 'asc' ? '↑' : '↓'}
        </button>
        <label className="ff-dirsfirst" title="List folders before files">
          <input
            type="checkbox"
            checked={sort.dirsFirst}
            onChange={(e) => onSortChange({ ...sort, dirsFirst: e.target.checked })}
          />
          Folders first
        </label>
        {!filtering && total > 0 && (
          <span className="ff-count" title="Files in this folder">
            {total} {total === 1 ? 'item' : 'items'}
          </span>
        )}
      </div>
    </div>
  )
}
