// Foundation (cluster gate) — settings export/import.
//
// Pure serialization layer. Reads/writes the existing per-feature JSON stores
// in `userData/`. Settings live in the renderer's localStorage store, which
// pushes its full snapshot here on every change via the `settings:sync` IPC
// so the on-disk file stays canonical. The export bundle reads the real
// file (not a hardcoded default) and the import flow re-applies the same
// snapshot to the renderer via the `settings:imported` event. Importing
// requires an explicit `mode: 'merge' | 'replace'` so a mistaken overwrite
// can't silently nuke the user's saved connections.
//
// On export, secret fields (`password`, `passphrase`, `privateKeyPath`) are
// STRIPPED from every connection — including the nested `jump` bastion hop.
// The bundle is versioned (`version: 1`) so future fields can be added
// without breaking older files.

import { app, dialog, BrowserWindow } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import type {
  AgentKind,
  ApprovalRule,
  AttentionSettingsSnapshot,
  DefaultShellPref,
  SavedConnection,
  SettingsExportBundle,
  SettingsSnapshot,
  STTSettings,
  Snippet,
  TerminalBg,
  TerminalPrefs,
  Workspace
} from '@shared/types'
import * as approvalRules from '../agent/approval-rules'

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
  // Settings are kept in sync with the renderer's localStorage by the
  // `settings:sync` IPC; read whatever's on disk (full or legacy 4-field
  // shape) and merge over the same defaults the renderer uses so the bundle
  // is always self-describing.
  const defaults = defaultSettingsSnapshot()
  const raw = await readJson<Partial<SettingsSnapshot> & Record<string, unknown>>(
    settingsFile(),
    {}
  )
  return mergeSnapshotWithDefaults(raw, defaults)
}

/**
 * The defaults the renderer uses in `store/settings.ts`. Duplicated here so
 * the export bundle is self-describing even when the renderer hasn't pushed
 * its snapshot yet (e.g. a fresh install on first run).
 */
export function defaultSettingsSnapshot(): SettingsSnapshot {
  return {
    themeId: 'tokyo-night',
    terminalBg: { color: '#16181d', image: null, dim: 0.35 },
    prefs: {
      fontSize: 14,
      fontFamily: 'Cascadia Code, Consolas, "Courier New", monospace',
      lineHeight: 1.0,
      cursorStyle: 'block',
      cursorBlink: true,
      scrollback: 10000,
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
    },
    attention: { enabled: true, sound: true, volume: 0.5, system: true, idle: true },
    showStatusBar: true,
    agentActivityCollapsed: false,
    inactivePaneDimming: true,
    sftpSidePane: false,
    activityIndicators: true,
    zenMode: false,
    agentKind: 'devterm' as AgentKind,
    agentPreferences: {
      provider: '',
      model: '',
      fallbackModels: [],
      resumeSessions: true,
      browserTools: true,
      agentHandoff: true,
      trustedSkills: []
    },
    remoteDetachedSessions: true,
    sessionRestore: true,
    transfersPanelOpen: false,
    defaultShell: { kind: 'auto' } as DefaultShellPref,
    gitPanelOpen: false,
    keybindings: {},
    stt: {
      enabled: true,
      modelId: 'base',
      language: 'auto',
      appendSpace: true,
      showFloatingStatus: true
    } as STTSettings,
    searchPersist: false
  }
}

/**
 * Shallow-merge a (possibly partial) snapshot with defaults. Every field is
 * individually type-checked so a hand-edited or older `settings.json`
 * (which had only themeId/terminalBg/prefs/autoReconnect) yields a valid
 * full snapshot.
 */
export function mergeSnapshotWithDefaults(
  raw: Partial<SettingsSnapshot> & Record<string, unknown>,
  defaults: SettingsSnapshot
): SettingsSnapshot {
  const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object'
  const out: SettingsSnapshot = { ...defaults }
  if (typeof raw.themeId === 'string') out.themeId = raw.themeId
  if (isObj(raw.terminalBg))
    out.terminalBg = { ...defaults.terminalBg, ...raw.terminalBg } as TerminalBg
  if (isObj(raw.prefs)) out.prefs = { ...defaults.prefs, ...raw.prefs } as TerminalPrefs
  if (isObj(raw.autoReconnect))
    out.autoReconnect = { ...defaults.autoReconnect, ...raw.autoReconnect }
  if (isObj(raw.attention)) {
    out.attention = { ...(defaults.attention ?? {}), ...raw.attention } as AttentionSettingsSnapshot
  }
  if (typeof raw.showStatusBar === 'boolean') out.showStatusBar = raw.showStatusBar
  if (typeof raw.agentActivityCollapsed === 'boolean')
    out.agentActivityCollapsed = raw.agentActivityCollapsed
  if (typeof raw.inactivePaneDimming === 'boolean')
    out.inactivePaneDimming = raw.inactivePaneDimming
  if (typeof raw.sftpSidePane === 'boolean') out.sftpSidePane = raw.sftpSidePane
  if (typeof raw.activityIndicators === 'boolean') out.activityIndicators = raw.activityIndicators
  if (typeof raw.zenMode === 'boolean') out.zenMode = raw.zenMode
  if (isAgentKind(raw.agentKind)) out.agentKind = raw.agentKind
  if (isObj(raw.agentPreferences)) {
    out.agentPreferences = {
      ...(defaults.agentPreferences ?? {
        provider: '',
        model: '',
        fallbackModels: [],
        resumeSessions: true,
        agentHandoff: true,
        trustedSkills: []
      }),
      ...raw.agentPreferences,
      agentHandoff:
        typeof raw.agentPreferences.agentHandoff === 'boolean'
          ? raw.agentPreferences.agentHandoff
          : (defaults.agentPreferences?.agentHandoff ?? true),
      fallbackModels: Array.isArray(raw.agentPreferences.fallbackModels)
        ? raw.agentPreferences.fallbackModels.filter(
            (value): value is string => typeof value === 'string'
          )
        : (defaults.agentPreferences?.fallbackModels ?? []),
      trustedSkills: Array.isArray(raw.agentPreferences.trustedSkills)
        ? (raw.agentPreferences.trustedSkills.filter(
            (value) => value && typeof value === 'object'
          ) as NonNullable<SettingsSnapshot['agentPreferences']>['trustedSkills'])
        : (defaults.agentPreferences?.trustedSkills ?? [])
    }
  }
  if (typeof raw.remoteDetachedSessions === 'boolean') {
    out.remoteDetachedSessions = raw.remoteDetachedSessions
  }
  if (typeof raw.sessionRestore === 'boolean') out.sessionRestore = raw.sessionRestore
  if (typeof raw.transfersPanelOpen === 'boolean') out.transfersPanelOpen = raw.transfersPanelOpen
  if (isObj(raw.defaultShell)) out.defaultShell = raw.defaultShell as DefaultShellPref
  if (typeof raw.gitPanelOpen === 'boolean') out.gitPanelOpen = raw.gitPanelOpen
  if (isObj(raw.keybindings)) out.keybindings = raw.keybindings as SettingsSnapshot['keybindings']
  if (isObj(raw.stt)) out.stt = { ...(defaults.stt ?? {}), ...raw.stt } as STTSettings
  if (typeof raw.searchPersist === 'boolean') out.searchPersist = raw.searchPersist
  return out
}

function isAgentKind(value: unknown): value is AgentKind {
  return (
    value === 'devterm' ||
    value === 'claude' ||
    value === 'pi' ||
    value === 'opencode' ||
    value === 'kimi' ||
    value === 'grok' ||
    value === 'codex' ||
    value === 'antigravity'
  )
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
  const raw = await readJson<{ connections?: Array<Record<string, unknown>> }>(
    connectionsFile(),
    {}
  )
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

// Renderer controls such as font-size/volume sliders can emit many snapshots
// per second. Keep localStorage immediate in the renderer, but coalesce the
// on-disk mirror and serialize writes so two atomic renames never race over the
// same settings.json.tmp file.
const SNAPSHOT_DEBOUNCE_MS = 120
let pendingSnapshot: SettingsSnapshot | null = null
let snapshotTimer: NodeJS.Timeout | null = null
let snapshotWrite: Promise<void> = Promise.resolve()

export function scheduleSnapshot(s: SettingsSnapshot): void {
  pendingSnapshot = s
  if (snapshotTimer) return
  snapshotTimer = setTimeout(() => {
    snapshotTimer = null
    void flushScheduledSnapshot().catch((err) => {
      console.warn('settings:sync write failed:', err)
    })
  }, SNAPSHOT_DEBOUNCE_MS)
}

export async function flushScheduledSnapshot(): Promise<void> {
  if (snapshotTimer) clearTimeout(snapshotTimer)
  snapshotTimer = null
  const next = pendingSnapshot
  pendingSnapshot = null
  if (next) {
    snapshotWrite = snapshotWrite.catch(() => undefined).then(() => writeSettingsSnapshot(next))
  }
  await snapshotWrite
}

/**
 * Write the live renderer settings snapshot to `userData/settings.json`.
 * Called from the `settings:sync` IPC on every renderer `persist()` so the
 * on-disk file is the canonical source for export/import. Tolerant of any
 * (possibly partial) snapshot — we just write whatever the renderer sends.
 */
export async function writeSnapshot(s: SettingsSnapshot): Promise<void> {
  pendingSnapshot = s
  await flushScheduledSnapshot()
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
  await flushScheduledSnapshot()
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
  /** The settings snapshot that was applied, so the renderer can re-load its store. */
  settings?: SettingsSnapshot
  error?: string
}

export async function importAll(
  bundle: SettingsExportBundle,
  opts: { mode: 'merge' | 'replace' }
): Promise<ImportResult> {
  if (!bundle || bundle.version !== 1) {
    return { ok: false, error: 'Unsupported bundle version' }
  }
  // Validate array fields before writing anything so a malformed bundle can't
  // partially replace snippets/workspaces/rules then fail mid-way.
  if (!Array.isArray(bundle.snippets)) {
    return { ok: false, error: 'Invalid bundle: snippets must be an array' }
  }
  if (!Array.isArray(bundle.workspaces)) {
    return { ok: false, error: 'Invalid bundle: workspaces must be an array' }
  }
  if (!Array.isArray(bundle.approvalRules)) {
    return { ok: false, error: 'Invalid bundle: approvalRules must be an array' }
  }
  try {
    // Drop any debounced pre-import snapshot so it can't overwrite the
    // imported settings.json after we write.
    pendingSnapshot = null
    // Always merge missing fields with the renderer's defaults so an older
    // bundle (with only themeId/terminalBg/prefs/autoReconnect) still
    // produces a complete snapshot for the renderer to apply.
    const settings = mergeSnapshotWithDefaults(
      bundle.settings as Record<string, unknown>,
      defaultSettingsSnapshot()
    )
    if (opts.mode === 'replace') {
      await writeSettingsSnapshot(settings)
      await writeSnippets(bundle.snippets)
      await writeWorkspaces(bundle.workspaces)
      await writeApprovalRules(bundle.approvalRules)
    } else {
      // merge: keep existing entries that aren't present in the bundle.
      // Settings: bundle wins (it's a single object). Snippets/workspaces/
      // approval rules: dedupe by id; bundle entries override existing ones
      // with the same id, and missing ones are appended.
      await writeSettingsSnapshot(settings)
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
      },
      settings
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

export async function importFromPath(getWindow: () => BrowserWindow | null): Promise<ImportResult> {
  await flushScheduledSnapshot()
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
    return {
      ok: false,
      error: 'Invalid JSON: ' + (err instanceof Error ? err.message : String(err))
    }
  }
  // The dialog-driven import always uses 'merge' so the user can't accidentally
  // wipe their existing data. A 'replace' mode is available via the file API
  // (e.g. for scripting / tests) but not exposed in the UI.
  return importAll(bundle, { mode: 'merge' })
}
