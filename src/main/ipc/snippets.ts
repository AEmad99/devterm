import { app, ipcMain } from 'electron'
import { randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import { join } from 'path'
import { IPC, type Snippet } from '@shared/types'

// Saved command scriptlets. No secrets are stored here, so like workspaces.json
// this file is plain JSON (atomic .tmp + rename so a crash can't corrupt it).
const storeFile = () => join(app.getPath('userData'), 'snippets.json')

async function readAll(): Promise<Snippet[]> {
  try {
    const raw = await fs.readFile(storeFile(), 'utf8')
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed?.snippets) ? parsed.snippets : []
  } catch {
    return [] // missing or unreadable file → no saved snippets
  }
}

async function writeAll(list: Snippet[]): Promise<void> {
  const tmp = storeFile() + '.tmp'
  await fs.writeFile(tmp, JSON.stringify({ version: 1, snippets: list }, null, 2), 'utf8')
  await fs.rename(tmp, storeFile()) // atomic replace so a crash mid-write can't corrupt the store
}

export function registerSnippetsIpc(): void {
  ipcMain.handle(IPC.snippetsList, () => readAll())

  ipcMain.handle(IPC.snippetsSave, async (_e, snippet: Snippet) => {
    const list = await readAll()
    const id = snippet.id || randomUUID()
    const entry: Snippet = { ...snippet, id }
    const idx = list.findIndex((s) => s.id === id)
    if (idx >= 0) list[idx] = entry
    else list.push(entry)
    await writeAll(list)
    return list
  })

  ipcMain.handle(IPC.snippetsDelete, async (_e, id: string) => {
    const list = (await readAll()).filter((s) => s.id !== id)
    await writeAll(list)
    return list
  })
}
