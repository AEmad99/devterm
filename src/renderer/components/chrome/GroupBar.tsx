import type { Dispatch, SetStateAction } from 'react'
import { IconTerminals, IconGroup, IconSave, IconClose, IconPlus } from '../common/Icons'
import { DEFAULT_GROUP, type Group } from '../../store/layout'
import type { Session } from '../../store/sessions'

interface GroupBarProps {
  groups: Group[]
  activeGroupId: string
  sessionsRef: Session[]
  dragOverGroup: string | null
  setDragOverGroup: Dispatch<SetStateAction<string | null>>
  switchGroup: (id: string) => void
  closeGroup: (id: string) => void
  createGroupAndLocal: () => void
  moveToGroup: (sid: string, gid: string) => void
  spinOffGroup: (sid: string) => void
  launchedFromId?: string
  capturable: Session[]
  onSaveNew: () => void
  onSaveBack: () => void
}

export default function GroupBar({
  groups,
  activeGroupId,
  sessionsRef,
  dragOverGroup,
  setDragOverGroup,
  switchGroup,
  closeGroup,
  createGroupAndLocal,
  moveToGroup,
  spinOffGroup,
  launchedFromId,
  capturable,
  onSaveNew,
  onSaveBack
}: GroupBarProps) {
  const groupCount = (gid: string) =>
    sessionsRef.filter((s) => (s.groupId || DEFAULT_GROUP) === gid).length

  return (
    <div className="group-bar">
      {groups.map((g) => (
        <div
          key={g.id}
          className={`group-tab ${g.id === activeGroupId ? 'active' : ''} ${
            dragOverGroup === g.id ? 'drop-target' : ''
          }`}
          onClick={() => switchGroup(g.id)}
          title={
            g.id === DEFAULT_GROUP
              ? 'Ungrouped terminals — drag a tab here to move it in'
              : `Group: ${g.name} — drag a tab here to move it in`
          }
          onDragOver={(e) => {
            e.preventDefault()
            e.dataTransfer.dropEffect = 'move'
            if (dragOverGroup !== g.id) setDragOverGroup(g.id)
          }}
          onDragLeave={() => setDragOverGroup((v) => (v === g.id ? null : v))}
          onDrop={(e) => {
            e.preventDefault()
            moveToGroup(e.dataTransfer.getData('text/plain'), g.id)
            setDragOverGroup(null)
          }}
        >
          <span className="group-icon">
            {g.id === DEFAULT_GROUP ? <IconTerminals size={14} /> : <IconGroup size={14} />}
          </span>
          <span className="group-name">{g.name}</span>
          <span className="group-count">{groupCount(g.id)}</span>
          {g.id !== DEFAULT_GROUP && (
            <span
              className="group-close"
              title="Close group (closes its terminals)"
              onClick={(e) => {
                e.stopPropagation()
                closeGroup(g.id)
              }}
            >
              <IconClose size={12} />
            </span>
          )}
        </div>
      ))}
      <div
        className={`group-new ${dragOverGroup === '__new__' ? 'drop-target' : ''}`}
        title="New group with a local terminal (or drop a terminal here to group it)"
        onClick={createGroupAndLocal}
        onDragOver={(e) => {
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
          if (dragOverGroup !== '__new__') setDragOverGroup('__new__')
        }}
        onDragLeave={() => setDragOverGroup((v) => (v === '__new__' ? null : v))}
        onDrop={(e) => {
          e.preventDefault()
          spinOffGroup(e.dataTransfer.getData('text/plain'))
          setDragOverGroup(null)
        }}
      >
        <IconPlus size={14} />
      </div>
      <span className="spacer" />
      {launchedFromId ? (
        <button
          className="group-save group-save-back"
          title="Save changes back to the workspace this group was launched from"
          disabled={capturable.length === 0}
          onClick={() => void onSaveBack()}
        >
          <IconSave size={14} />
          <span>Save back to workspace</span>
        </button>
      ) : null}
      <button
        className="group-save"
        title="Save this group's terminals as a new workspace"
        disabled={capturable.length === 0}
        onClick={onSaveNew}
      >
        <IconSave size={14} />
        <span>{launchedFromId ? 'Save as new' : 'Save group'}</span>
      </button>
    </div>
  )
}
