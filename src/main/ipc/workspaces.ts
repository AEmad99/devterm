import { app, ipcMain } from 'electron'
import { randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import { join } from 'path'
import { IPC, type Workspace, type WorkspaceItem } from '@shared/types'

// Saved terminal presets. No secrets are stored here (remote items only carry a
// connectionId), so unlike connections.json this file is plain JSON.
const storeFile = () => join(app.getPath('userData'), 'workspaces.json')

/**
 * Migrate pre-1.0.1 remote-only workspaces (which stored `connectionIds` and a
 * layout whose leaves referenced connection ids) into the current item model.
 * Using item.id = connectionId keeps the legacy layout's leaf references valid.
 */
function migrate(w: Workspace): Workspace {
  if (Array.isArray(w.items)) return w
  const items: WorkspaceItem[] = (w.connectionIds ?? []).map((cid) => ({
    id: cid,
    kind: 'remote',
    connectionId: cid
  }))
  return { id: w.id, name: w.name, items, layout: w.layout ?? null }
}

async function readAll(): Promise<Workspace[]> {
  try {
    const raw = await fs.readFile(storeFile(), 'utf8')
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed?.workspaces) ? parsed.workspaces.map(migrate) : []
  } catch {
    return [] // missing or unreadable file → no saved workspaces
  }
}

async function writeAll(list: Workspace[]): Promise<void> {
  const tmp = storeFile() + '.tmp'
  await fs.writeFile(tmp, JSON.stringify({ version: 1, workspaces: list }, null, 2), 'utf8')
  await fs.rename(tmp, storeFile()) // atomic replace so a crash mid-write can't corrupt the store
}

export function registerWorkspacesIpc(): void {
  ipcMain.handle(IPC.workspacesList, () => readAll())

  ipcMain.handle(IPC.workspacesSave, async (_e, ws: Workspace) => {
    const list = await readAll()
    const id = ws.id || randomUUID()
    const entry: Workspace = { ...ws, id }
    const idx = list.findIndex((w) => w.id === id)
    if (idx >= 0) list[idx] = entry
    else list.push(entry)
    await writeAll(list)
    return list
  })

  ipcMain.handle(IPC.workspacesDelete, async (_e, id: string) => {
    const list = (await readAll()).filter((w) => w.id !== id)
    await writeAll(list)
    return list
  })
}
