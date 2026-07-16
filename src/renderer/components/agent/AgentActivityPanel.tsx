import { useEffect, useMemo, useRef, useState } from 'react'
import type { BridgeActivityEntry } from '@shared/types'
import { useBridgeActivity, formatDuration, formatTime } from '../../lib/bridge-activity'

/**
 * Per-session timeline of MCP bridge events: tool calls, approval asks and
 * outcomes, bridge state transitions, and (future) transport heartbeats.
 * Lives inside `RemoteSessionView` as a third row in the term-agent split;
 * collapsed by default so the agent terminal stays the focus. State
 * (collapsed / not) is persisted in the settings store, not local to the
 * component, so it survives remounts and app restarts.
 */

type Filter = 'all' | 'tools' | 'approvals' | 'errors'

const KIND_GLYPH: Record<BridgeActivityEntry['kind'], string> = {
  tool_call: '⚙',
  approval_request: '?',
  approval_outcome: '✓',
  transport: '⇄',
  agent_heartbeat: '♥',
  bridge_state: '◌'
}

const KIND_LABEL: Record<BridgeActivityEntry['kind'], string> = {
  tool_call: 'Tool call',
  approval_request: 'Approval requested',
  approval_outcome: 'Approval decided',
  transport: 'Transport',
  agent_heartbeat: 'Heartbeat',
  bridge_state: 'Bridge state'
}

function isError(e: BridgeActivityEntry): boolean {
  if (e.kind === 'tool_call') return e.ok === false
  if (e.kind === 'approval_outcome') return e.ok === false
  if (e.kind === 'bridge_state') return e.ok === false
  return false
}

function isApproval(e: BridgeActivityEntry): boolean {
  return e.kind === 'approval_request' || e.kind === 'approval_outcome'
}

function isToolCall(e: BridgeActivityEntry): boolean {
  return e.kind === 'tool_call'
}

export default function AgentActivityPanel({
  sessionId,
  hostLabel
}: {
  sessionId: string
  /** Short hostname/label for the header — shows whose activity this is. */
  hostLabel: string
}) {
  const { entries, loading, clear } = useBridgeActivity(sessionId)
  const [filter, setFilter] = useState<Filter>('all')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  // Inline export feedback — local state, not a DOM data-attribute, so multiple
  // agent panes never flash each other's panel.
  const [exportMsg, setExportMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const exportMsgTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (exportMsgTimer.current) clearTimeout(exportMsgTimer.current)
    }
  }, [])

  const visible = useMemo(() => {
    if (filter === 'all') return entries
    if (filter === 'tools') return entries.filter(isToolCall)
    if (filter === 'approvals') return entries.filter(isApproval)
    return entries.filter(isError)
  }, [entries, filter])

  const showExportMsg = (ok: boolean, text: string) => {
    if (exportMsgTimer.current) clearTimeout(exportMsgTimer.current)
    setExportMsg({ ok, text })
    exportMsgTimer.current = setTimeout(() => setExportMsg(null), 3000)
  }

  const doExport = async (sid: string) => {
    try {
      const written = await window.devterm.bridgeActivity.export(sid)
      if (written == null) return // user canceled
      showExportMsg(true, `Exported ${written} entries`)
    } catch (e) {
      showExportMsg(false, `Export failed: ${(e as Error).message}`)
    }
  }

  return (
    <div className="agent-activity">
      <div className="agent-activity-head">
        <div className="agent-activity-title">
          <span className="agent-activity-glyph">≡</span>
          <span>Activity</span>
          <span className="agent-activity-host" title={`session ${sessionId}`}>
            {hostLabel}
          </span>
        </div>
        <div className="agent-activity-filters" role="tablist">
          {(['all', 'tools', 'approvals', 'errors'] as const).map((f) => (
            <button
              key={f}
              role="tab"
              aria-selected={filter === f}
              className={`chip ${filter === f ? 'active' : ''}`}
              onClick={() => setFilter(f)}
            >
              {f}
            </button>
          ))}
        </div>
        <div className="agent-activity-actions">
          {exportMsg && (
            <span
              className={`agent-activity-export-msg ${exportMsg.ok ? 'ok' : 'err'}`}
              role="status"
            >
              {exportMsg.text}
            </span>
          )}
          <button
            className="ghost small"
            onClick={() => void doExport(sessionId)}
            title="Export every entry for this session (in-memory + on-disk tail) as JSONL"
            disabled={loading}
          >
            Export
          </button>
          <button
            className="ghost small"
            onClick={clear}
            title="Drop the in-memory view (the on-disk tail is kept)"
            disabled={loading || entries.length === 0}
          >
            Clear
          </button>
        </div>
      </div>
      <div className="agent-activity-body">
        {loading && entries.length === 0 ? (
          <div className="agent-activity-empty">Loading…</div>
        ) : visible.length === 0 ? (
          <div className="agent-activity-empty">
            {entries.length === 0
              ? 'No activity yet. Tool calls and approval requests will appear here.'
              : `No ${filter} events in the recent window.`}
          </div>
        ) : (
          <ul className="agent-activity-list">
            {visible.map((e) => {
              const expanded = expandedId === e.id
              return (
                <li
                  key={e.id}
                  className={`agent-activity-row ${expanded ? 'is-expanded' : ''} ${
                    isError(e) ? 'is-error' : ''
                  }`}
                  onClick={() => setExpandedId(expanded ? null : e.id)}
                >
                  <div className="agent-activity-line">
                    <span
                      className={`agent-activity-kind kind-${e.kind}`}
                      title={KIND_LABEL[e.kind]}
                    >
                      {KIND_GLYPH[e.kind]}
                    </span>
                    <span className="agent-activity-ts">{formatTime(e.ts)}</span>
                    {e.tool && <span className="agent-activity-tool">{e.tool}</span>}
                    <span className="agent-activity-detail">{e.detail}</span>
                    {e.durationMs != null && (
                      <span className="agent-activity-dur">{formatDuration(e.durationMs)}</span>
                    )}
                    <span
                      className={`agent-activity-chevron ${expanded ? 'open' : ''}`}
                      aria-hidden
                    >
                      ▸
                    </span>
                  </div>
                  {expanded && (
                    <div
                      className="agent-activity-detail-full"
                      onClick={(ev) => ev.stopPropagation()}
                    >
                      <div className="agent-activity-detail-row">
                        <span className="k">kind</span>
                        <span className="v">{e.kind}</span>
                      </div>
                      {e.tool && (
                        <div className="agent-activity-detail-row">
                          <span className="k">tool</span>
                          <span className="v">{e.tool}</span>
                        </div>
                      )}
                      <div className="agent-activity-detail-row">
                        <span className="k">time</span>
                        <span className="v">{formatTime(e.ts)}</span>
                      </div>
                      {e.durationMs != null && (
                        <div className="agent-activity-detail-row">
                          <span className="k">duration</span>
                          <span className="v">{formatDuration(e.durationMs)}</span>
                        </div>
                      )}
                      <div className="agent-activity-detail-row">
                        <span className="k">ok</span>
                        <span className={`v ${e.ok === false ? 'bad' : 'ok'}`}>
                          {e.ok === undefined ? '—' : e.ok ? 'true' : 'false'}
                        </span>
                      </div>
                      <div className="agent-activity-detail-row block">
                        <span className="k">detail</span>
                        <pre className="v">{e.detail}</pre>
                      </div>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
