import { useEffect, useMemo, useState } from 'react'
import ModalShell from '../common/ModalShell'
import { IconGrid } from '../common/Icons'
import { GRID_MAX_COLS, GRID_MAX_ROWS, GRID_MIN_DIM, validateGridSpec } from '../../lib/grid'
import { createTerminalGrid, type CreateGridResult } from '../../lib/createGrid'
import type { SavedConnection } from '@shared/types'

interface Preset {
  label: string
  rows: number
  cols: number
}

const PRESETS: Preset[] = [
  { label: '2×2', rows: 2, cols: 2 },
  { label: '2×3', rows: 2, cols: 3 },
  { label: '3×3', rows: 3, cols: 3 },
  { label: '4×2', rows: 4, cols: 2 }
]

export default function CreateGridModal({
  open,
  onClose,
  onCreated
}: {
  open: boolean
  onClose: () => void
  onCreated?: (result: CreateGridResult) => void
}) {
  const [rows, setRows] = useState(2)
  const [cols, setCols] = useState(2)
  const [kind, setKind] = useState<'local' | 'remote'>('local')
  const [broadcast, setBroadcast] = useState('')
  const [broadcastExecute, setBroadcastExecute] = useState(true)
  const [broadcastOpen, setBroadcastOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Remote-only state.
  const [connections, setConnections] = useState<SavedConnection[]>([])
  const [connectionId, setConnectionId] = useState<string>('')

  // Load saved connections lazily when the modal opens, so the picker is
  // ready by the time the user picks "Remote (SSH)".
  useEffect(() => {
    if (!open) return
    window.devterm.connections
      .list()
      .then((list) => {
        setConnections(list)
        if (list.length > 0 && !connectionId) setConnectionId(list[0].id)
      })
      .catch(() => undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const validation = useMemo(() => validateGridSpec({ rows, cols }), [rows, cols])
  const total = rows * cols
  const canCreate =
    !validation &&
    !busy &&
    (kind === 'local' || (kind === 'remote' && connectionId && connections.length > 0))

  const applyPreset = (p: Preset) => {
    setRows(p.rows)
    setCols(p.cols)
  }

  const clampDim = (n: number) => Math.min(GRID_MAX_ROWS, Math.max(GRID_MIN_DIM, n))

  const handleCreate = () => {
    if (validation) return
    if (kind === 'remote' && !connectionId) {
      setError('Pick a saved SSH connection first')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const result = createTerminalGrid({
        rows,
        cols,
        kind,
        connectionId: kind === 'remote' ? connectionId : undefined,
        broadcast:
          broadcast.trim() && broadcastOpen
            ? { command: broadcast.trim(), execute: broadcastExecute }
            : undefined
      })
      onCreated?.(result)
      onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      title="Create terminal grid"
      size="md"
      className="create-grid-modal"
      footer={
        <>
          <span className="spacer" />
          <button className="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="primary" onClick={handleCreate} disabled={!canCreate}>
            {busy ? 'Creating…' : `Create grid (${total})`}
          </button>
        </>
      }
    >
      <div className="grid-presets">
        {PRESETS.map((p) => (
          <button
            key={p.label}
            type="button"
            className={`grid-preset ${rows === p.rows && cols === p.cols ? 'active' : ''}`}
            onClick={() => applyPreset(p)}
          >
            {p.label}
          </button>
        ))}
      </div>

      <div className="grid-dims row">
        <label>
          Rows
          <input
            type="number"
            min={GRID_MIN_DIM}
            max={GRID_MAX_ROWS}
            value={rows}
            onChange={(e) => setRows(clampDim(parseInt(e.target.value || '1', 10)))}
          />
        </label>
        <span className="grid-dims-x">×</span>
        <label>
          Columns
          <input
            type="number"
            min={GRID_MIN_DIM}
            max={GRID_MAX_COLS}
            value={cols}
            onChange={(e) => setCols(clampDim(parseInt(e.target.value || '1', 10)))}
          />
        </label>
      </div>

      <div className="grid-preview" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
        {Array.from({ length: total }).map((_, i) => (
          <div key={i} className="grid-preview-cell" />
        ))}
      </div>

      <div className="grid-kind">
        <label className={`grid-kind-option ${kind === 'local' ? 'active' : ''}`}>
          <input
            type="radio"
            name="grid-kind"
            value="local"
            checked={kind === 'local'}
            onChange={() => setKind('local')}
          />
          <span className="grid-kind-ico">
            <IconGrid size={20} />
          </span>
          <span>Local shells</span>
        </label>
        <label className={`grid-kind-option ${kind === 'remote' ? 'active' : ''}`}>
          <input
            type="radio"
            name="grid-kind"
            value="remote"
            checked={kind === 'remote'}
            onChange={() => setKind('remote')}
            disabled={connections.length === 0}
          />
          <span className="grid-kind-ico">
            <IconGrid size={20} />
          </span>
          <span>
            Remote (SSH)
            {connections.length === 0 && <small>no saved connections</small>}
          </span>
        </label>
      </div>

      {kind === 'remote' && connections.length > 0 && (
        <label className="grid-conn-picker">
          <span>Connection</span>
          <select
            className="text-input"
            value={connectionId}
            onChange={(e) => setConnectionId(e.target.value)}
          >
            {connections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.username}@{c.host}
                {c.port && c.port !== 22 ? `:${c.port}` : ''})
              </option>
            ))}
          </select>
          <small>Each grid cell opens its own SSH session to this host.</small>
        </label>
      )}

      <div className="grid-broadcast">
        <button
          type="button"
          className={`grid-broadcast-toggle ${broadcastOpen ? 'open' : ''}`}
          onClick={() => setBroadcastOpen((v) => !v)}
        >
          <span>Run command in all cells</span>
          <span className="grid-broadcast-chevron">›</span>
        </button>
        {broadcastOpen && (
          <div className="grid-broadcast-fields">
            <textarea
              className="grid-broadcast-cmd sn-mono"
              rows={2}
              placeholder="Command to send to every cell…"
              value={broadcast}
              onChange={(e) => setBroadcast(e.target.value)}
            />
            <label className="grid-broadcast-exec checkbox">
              <input
                type="checkbox"
                checked={broadcastExecute}
                onChange={(e) => setBroadcastExecute(e.target.checked)}
              />
              Press Enter (run it)
            </label>
          </div>
        )}
      </div>

      {validation && <div className="grid-error">{validation}</div>}
      {error && <div className="grid-error">{error}</div>}
      {!validation && !error && (
        <div className="grid-hint">
          Opens {total} {kind === 'local' ? 'local' : 'remote SSH'} terminal
          {total === 1 ? '' : 's'} in a new group.
          {broadcast.trim() &&
            broadcastOpen &&
            ' The command will be broadcast after the grid is ready.'}
        </div>
      )}
    </ModalShell>
  )
}
