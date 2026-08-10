import { app, ipcMain } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import { IPC, type SessionRestoreSnapshot } from '@shared/types'

const storeFile = () => join(app.getPath('userData'), 'session-restore.json')

function isValidSnapshot(v: unknown): v is SessionRestoreSnapshot {
  if (!v || typeof v !== 'object') return false
  const s = v as SessionRestoreSnapshot
  if (s.version !== 1) return false
  if (!Array.isArray(s.groups)) return false
  return true
}

async function readSnapshot(): Promise<SessionRestoreSnapshot | null> {
  try {
    const raw = await fs.readFile(storeFile(), 'utf8')
    const parsed = JSON.parse(raw) as unknown
    return isValidSnapshot(parsed) ? parsed : null
  } catch {
    return null
  }
}

async function writeSnapshot(snap: SessionRestoreSnapshot): Promise<void> {
  const tmp = storeFile() + '.tmp'
  await fs.writeFile(tmp, JSON.stringify(snap, null, 2), 'utf8')
  await fs.rename(tmp, storeFile())
}

export function registerSessionRestoreIpc(): void {
  ipcMain.handle(IPC.sessionRestoreLoad, () => readSnapshot())

  ipcMain.handle(IPC.sessionRestoreSave, async (_e, snap: SessionRestoreSnapshot) => {
    if (!isValidSnapshot(snap)) return
    // Cap size: drop groups with no items; keep at most 20 groups / 64 items each.
    const groups = snap.groups
      .filter((g) => Array.isArray(g.items) && g.items.length > 0)
      .slice(0, 20)
      .map((g) => ({
        name: typeof g.name === 'string' && g.name.trim() ? g.name.trim() : 'Terminals',
        items: g.items.slice(0, 64).map((it) => ({
          id: String(it.id),
          kind: it.kind === 'remote' ? ('remote' as const) : ('local' as const),
          connectionId: typeof it.connectionId === 'string' ? it.connectionId : undefined,
          cwd: typeof it.cwd === 'string' ? it.cwd : undefined,
          title: typeof it.title === 'string' ? it.title : undefined
        })),
        layout: g.layout ?? null
      }))
      .filter((g) => g.items.length > 0)
    const cleaned: SessionRestoreSnapshot = {
      version: 1,
      savedAt: typeof snap.savedAt === 'number' ? snap.savedAt : Date.now(),
      groups,
      activeGroupIndex:
        typeof snap.activeGroupIndex === 'number' ? snap.activeGroupIndex : undefined
    }
    await writeSnapshot(cleaned)
  })

  ipcMain.handle(IPC.sessionRestoreClear, async () => {
    try {
      await fs.unlink(storeFile())
    } catch {
      /* missing is fine */
    }
  })
}
