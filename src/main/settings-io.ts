// Foundation (cluster gate) — settings export/import.
//
// Pure serialization layer. Reads/writes the existing per-feature JSON stores
// in `userData/`. Does NOT touch the live renderer settings store (which is
// localStorage-backed and renderer-only); it only round-trips the on-disk
// copies. Importing requires an explicit `mode: 'merge' | 'replace'` so a
// mistaken overwrite can't silently nuke the user's saved connections.
//
// On export, secret fields (`password`, `passphrase`, `privateKeyPath`) are
// STRIPPED from every connection — including the nested `jump` bastion hop.
// The bundle is versioned (`version: 1`) so future fields can be added
// without breaking older files.

import { app, dialog, BrowserWindow } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import type {
  ApprovalRule,
  SavedConnection,
  SettingsExportBundle,
  SettingsSnapshot,
  Snippet,
  Workspace
} from '@shared/types'
import * as approvalRules from './approval-rules'

const userDataPath = () => app.getPath('userData')

const settingsFile = () => join(userDataPath(), 'settings.json')
const snippetsFile = () => join(userDataPath(), 'snippets.json')
const connectionsFile = () => join(userDataPath(), 'connections.json')
const workspacesFile = () => join(userDataPath(), 'workspaces.json')
const approvalRulesFile = () => join(userDataPath(), 'approval-rules.json')

// ---------------------------------------------------------------------------
// Read helpers — tolerant of missing/malformed files (returns sensible empty)
// ---------------------------------------------------------------------------

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(file, 'utf8')
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

async function readSettingsSnapshot(): Promise<SettingsSnapshot> {
  // The main process doesn't have a canonical settings.json yet — settings
  // live in renderer localStorage. For export, fall back to the same defaults
  // the renderer uses so the bundle is still self-describing.
  const defaults: SettingsSnapshot = {
    themeId: 'tokyo-night',
    terminalBg: { color: '#16181d', image: null, dim: 0.35 },
    prefs: {
      fontSize: 14,
      fontFamily: 'Cascadia Code, Consolas, "Courier New", monospace',
      lineHeight: 1.0,
      cursorStyle: 'block',
      cursorBlink: true,
      scrollback: 1000,
      copyOnSelect: false,
      rightClickPaste: false,
      scrollSensitivity: 1,
      bell: 'none'
    },
    autoReconnect: {
      enabled: true,
      maxAttempts: 5,
      baseDelayMs: 1000,
      maxDelayMs: 30000,
      factor: 2
    }
  }
  const raw = await readJson<Partial<SettingsSnapshot> & Record<string, unknown>>(
    settingsFile(),
    {}
  )
  // Shallow merge over defaults so older/missing files still produce a valid
  // snapshot. We trust the file's shape to be a partial SettingsSnapshot.
  return {
    themeId: typeof raw.themeId === 'string' ? raw.themeId : defaults.themeId,
    terminalBg: { ...defaults.terminalBg, ...(raw.terminalBg ?? {}) },
    prefs: { ...defaults.prefs, ...(raw.prefs ?? {}) },
    autoReconnect: { ...defaults.autoReconnect, ...(raw.autoReconnect ?? {}) }
  }
}

async function readSnippets(): Promise<Snippet[]> {
  const raw = await readJson<{ snippets?: unknown }>(snippetsFile(), {})
  return Array.isArray(raw.snippets) ? (raw.snippets as Snippet[]) : []
}

async function readWorkspaces(): Promise<Workspace[]> {
  const raw = await readJson<{ workspaces?: unknown }>(workspacesFile(), {})
  return Array.isArray(raw.workspaces) ? (raw.workspaces as Workspace[]) : []
}

async function readApprovalRules(): Promise<ApprovalRule[]> {
  // Use the approval-rules module's own reader so we get a consistent shape.
  return approvalRules.list()
}

// Connections on disk are encrypted with Electron safeStorage. Read the raw
// file and STRIP the secret fields; we never want to bundle ciphertext into
// a portable export (the OS keychain isn't portable). Plain `password` etc.
// would have been encrypted, so dropping them here is safe.
const SECRET_FIELDS = ['password', 'passphrase', 'privateKeyPath'] as const

function stripSecrets<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = { ...obj }
  for (const f of SECRET_FIELDS) delete out[f]
  return out as T
}

async function readConnectionsSanitized(): Promise<SavedConnection[]> {
  // Read the encrypted file (mirrors the storage layout used by
  // `src/main/ipc/connections.ts`). Even if a field is unencrypted (RAW
  // prefix) it gets stripped by `stripSecrets` — we never want plaintext
  // secrets in the export bundle.
  const raw = await readJson<{ connections?: Array<Record<string, unknown>> }>(connectionsFile(), {})
  if (!Array.isArray(raw.connections)) return []
  return raw.connections.map((c) => {
    const out = stripSecrets(c)
    if (out.jump && typeof out.jump === 'object') {
      out.jump = stripSecrets(out.jump as Record<string, unknown>)
    }
    return out as unknown as SavedConnection
  })
}

// ---------------------------------------------------------------------------
// Write helpers — atomic .tmp + rename, matching the snippets/workspaces style
// ---------------------------------------------------------------------------

async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  const tmp = file + '.tmp'
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
  await fs.rename(tmp, file)
}

async function writeSettingsSnapshot(s: SettingsSnapshot): Promise<void> {
  await writeJsonAtomic(settingsFile(), { version: 1, ...s })
}

async function writeSnippets(list: Snippet[]): Promise<void> {
  await writeJsonAtomic(snippetsFile(), { version: 1, snippets: list })
}

async function writeWorkspaces(list: Workspace[]): Promise<void> {
  await writeJsonAtomic(workspacesFile(), { version: 1, workspaces: list })
}

async function writeApprovalRules(list: ApprovalRule[]): Promise<void> {
  // Write the full list through the approval-rules file directly (atomic
  // .tmp + rename matches the module's pattern). We bypass the module's
  // public `add`/`remove` API because it would re-stamp id/createdAt — we
  // want to preserve them on import.
  await writeJsonAtomic(approvalRulesFile(), { version: 1, rules: list })
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function exportAll(): Promise<SettingsExportBundle> {
  const [settings, snippets, connections, workspaces, rules] = await Promise.all([
    readSettingsSnapshot(),
    readSnippets(),
    readConnectionsSanitized(),
    readWorkspaces(),
    readApprovalRules()
  ])
  return {
    version: 1,
    exportedAt: Date.now(),
    settings,
    snippets,
    connections,
    workspaces,
    approvalRules: rules
  }
}

export interface ImportCounts {
  settings: boolean
  snippets: number
  workspaces: number
  approvalRules: number
}

export interface ImportResult {
  ok: boolean
  counts?: ImportCounts
  error?: string
}

export async function importAll(
  bundle: SettingsExportBundle,
  opts: { mode: 'merge' | 'replace' }
): Promise<ImportResult> {
  if (!bundle || bundle.version !== 1) {
    return { ok: false, error: 'Unsupported bundle version' }
  }
  try {
    if (opts.mode === 'replace') {
      await writeSettingsSnapshot(bundle.settings)
      await writeSnippets(bundle.snippets)
      await writeWorkspaces(bundle.workspaces)
      await writeApprovalRules(bundle.approvalRules)
    } else {
      // merge: keep existing entries that aren't present in the bundle.
      // Settings: bundle wins (it's a single object). Snippets/workspaces/
      // approval rules: dedupe by id; bundle entries override existing ones
      // with the same id, and missing ones are appended.
      await writeSettingsSnapshot(bundle.settings)
      const [curSnippets, curWorkspaces, curRules] = await Promise.all([
        readSnippets(),
        readWorkspaces(),
        readApprovalRules()
      ])
      const mergedSnippets = mergeById(curSnippets, bundle.snippets) as Snippet[]
      const mergedWorkspaces = mergeById(curWorkspaces, bundle.workspaces) as Workspace[]
      const mergedRules = mergeById(curRules, bundle.approvalRules) as ApprovalRule[]
      await writeSnippets(mergedSnippets)
      await writeWorkspaces(mergedWorkspaces)
      await writeApprovalRules(mergedRules)
    }
    return {
      ok: true,
      counts: {
        settings: true,
        snippets: bundle.snippets.length,
        workspaces: bundle.workspaces.length,
        approvalRules: bundle.approvalRules.length
      }
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

function mergeById<T extends { id: string }>(current: T[], incoming: T[]): T[] {
  const byId = new Map<string, T>()
  for (const r of current) byId.set(r.id, r)
  for (const r of incoming) byId.set(r.id, r) // incoming wins on collision
  return Array.from(byId.values())
}

// ---------------------------------------------------------------------------
// File-dialog wrappers — pops the native save/open picker
// ---------------------------------------------------------------------------

export async function exportToPath(getWindow: () => BrowserWindow | null): Promise<string | null> {
  const win = getWindow()
  const opts = {
    title: 'Export DevTerm settings',
    defaultPath: `devterm-settings-${new Date().toISOString().slice(0, 10)}.json`,
    filters: [{ name: 'DevTerm settings', extensions: ['json'] }]
  }
  const result = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
  if (result.canceled || !result.filePath) return null
  const bundle = await exportAll()
  await fs.writeFile(result.filePath, JSON.stringify(bundle, null, 2), 'utf8')
  return result.filePath
}

export async function importFromPath(
  getWindow: () => BrowserWindow | null
): Promise<ImportResult> {
  const win = getWindow()
  const opts = {
    title: 'Import DevTerm settings',
    properties: ['openFile' as const],
    filters: [{ name: 'DevTerm settings', extensions: ['json'] }]
  }
  const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
  if (result.canceled || result.filePaths.length === 0) {
    return { ok: false, error: 'canceled' }
  }
  const file = result.filePaths[0]
  let raw: string
  try {
    raw = await fs.readFile(file, 'utf8')
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  let bundle: SettingsExportBundle
  try {
    const parsed = JSON.parse(raw) as SettingsExportBundle
    bundle = parsed
  } catch (err) {
    return { ok: false, error: 'Invalid JSON: ' + (err instanceof Error ? err.message : String(err)) }
  }
  // The dialog-driven import always uses 'merge' so the user can't accidentally
  // wipe their existing data. A 'replace' mode is available via the file API
  // (e.g. for scripting / tests) but not exposed in the UI.
  return importAll(bundle, { mode: 'merge' })
}
