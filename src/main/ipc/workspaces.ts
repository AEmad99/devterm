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
    // Preserve launch stats when a UI re-saves an existing workspace (e.g. via
    // the capture flow) — the renderer doesn't always re-send them.
    const existing = list.find((w) => w.id === id)
    const entry: Workspace = {
      ...ws,
      id,
      lastLaunchedAt: ws.lastLaunchedAt ?? existing?.lastLaunchedAt,
      launchCount: ws.launchCount ?? existing?.launchCount
    }
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

  // Cluster B: in-place rename (single-field update so a save doesn't have to
  // round-trip the whole workspace and risk dropping items/layout if the
  // renderer sends a partial).
  ipcMain.handle(IPC.workspacesRename, async (_e, id: string, name: string) => {
    const list = await readAll()
    const idx = list.findIndex((w) => w.id === id)
    if (idx < 0) return list
    const trimmed = (name ?? '').trim()
    list[idx] = { ...list[idx], name: trimmed.length > 0 ? trimmed : list[idx].name }
    await writeAll(list)
    return list
  })

  // Cluster B: duplicate the workspace with a fresh id and " (copy)" appended
  // to the name. Items get NEW item ids (so a future re-capture of the original
  // doesn't collide), but layout leaves are remapped to the new item ids.
  ipcMain.handle(IPC.workspacesDuplicate, async (_e, id: string) => {
    const list = await readAll()
    const src = list.find((w) => w.id === id)
    if (!src) return list
    const idMap = new Map<string, string>()
    const newItems: WorkspaceItem[] = src.items.map((it) => {
      const nid = randomUUID()
      idMap.set(it.id, nid)
      return { ...it, id: nid }
    })
    const remap = (tabs: string[]): string[] =>
      tabs.map((t) => idMap.get(t) ?? t).filter((t) => idMap.has(t))
    const remapLayout = (n: Workspace['layout']): Workspace['layout'] => {
      if (!n) return n
      if (n.type === 'leaf') {
        const tabs = remap(n.tabs)
        const active = n.active ? (idMap.get(n.active) ?? null) : null
        return { ...n, tabs, active }
      }
      return { ...n, children: n.children.map(remapLayout) as typeof n.children }
    }
    const copy: Workspace = {
      ...src,
      id: randomUUID(),
      name: `${src.name} (copy)`,
      items: newItems,
      layout: src.layout ? remapLayout(src.layout) : null,
      // Launch stats are about the original, not its copy.
      lastLaunchedAt: undefined,
      launchCount: undefined
    }
    list.push(copy)
    await writeAll(list)
    return list
  })

  // Cluster B: record a launch. Bumps launchCount and sets lastLaunchedAt; the
  // renderer calls this on every "Launch" (no idempotency — we count every
  // intentional launch, even the same one twice).
  ipcMain.handle(IPC.workspacesRecordLaunch, async (_e, id: string) => {
    const list = await readAll()
    const idx = list.findIndex((w) => w.id === id)
    if (idx < 0) return list
    const prev = list[idx]
    list[idx] = {
      ...prev,
      lastLaunchedAt: Date.now(),
      launchCount: (prev.launchCount ?? 0) + 1
    }
    await writeAll(list)
    return list
  })
}
