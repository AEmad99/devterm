import { app, ipcMain, safeStorage } from 'electron'
import { randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import { join } from 'path'
import {
  IPC,
  type SessionRestoreAuthMethod,
  type SessionRestoreBrowserTab,
  type SessionRestoreSshDraft,
  type SessionRestoreSshHop,
  type SessionRestoreSnapshot
} from '@shared/types'
import { globalOutputRings } from '../terminal/output-ring'
import {
  DEFAULT_PERSISTED_SCROLLBACK_LINES,
  MAX_PERSISTED_SCROLLBACK_BYTES,
  trimSessionScrollback
} from '../terminal/scrollback'
export {
  DEFAULT_PERSISTED_SCROLLBACK_LINES,
  MAX_PERSISTED_SCROLLBACK_LINES,
  trimSessionScrollback
} from '../terminal/scrollback'

const storeFile = () => join(app.getPath('userData'), 'session-restore.json')
const secretStoreFile = () => join(app.getPath('userData'), 'session-restore-secrets.json')

const MAX_TOTAL_PERSISTED_SCROLLBACK_BYTES = 32 * 1024 * 1024

type RestoreSecret = NonNullable<SessionRestoreSshDraft['restoreSecret']>
type EncodedRestoreSecret = {
  password?: string
  passphrase?: string
  jumpPassword?: string
  jumpPassphrase?: string
}

const AUTH_METHODS: readonly SessionRestoreAuthMethod[] = ['password', 'key', 'agent', 'none']

function isAuthMethod(value: unknown): value is SessionRestoreAuthMethod {
  return typeof value === 'string' && AUTH_METHODS.includes(value as SessionRestoreAuthMethod)
}

function finitePort(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(1, Math.min(65535, Math.floor(value)))
    : 22
}

function canUseSafeStorage(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

function encryptSecret(value: string | undefined): string | undefined {
  if (!value || !canUseSafeStorage()) return undefined
  try {
    return `v1:${safeStorage.encryptString(value).toString('base64')}`
  } catch {
    return undefined
  }
}

function decryptSecret(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.startsWith('v1:') || !canUseSafeStorage())
    return undefined
  try {
    return safeStorage.decryptString(Buffer.from(value.slice(3), 'base64'))
  } catch {
    return undefined
  }
}

async function readEncodedSecrets(): Promise<Record<string, EncodedRestoreSecret>> {
  try {
    const parsed = JSON.parse(await fs.readFile(secretStoreFile(), 'utf8')) as {
      version?: unknown
      secrets?: unknown
    }
    if (parsed.version !== 1 || !parsed.secrets || typeof parsed.secrets !== 'object') return {}
    const out: Record<string, EncodedRestoreSecret> = {}
    for (const [id, value] of Object.entries(parsed.secrets as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue
      const raw = value as Record<string, unknown>
      const secret: EncodedRestoreSecret = {}
      for (const key of ['password', 'passphrase', 'jumpPassword', 'jumpPassphrase'] as const) {
        if (typeof raw[key] === 'string') secret[key] = raw[key]
      }
      if (Object.keys(secret).length > 0) out[id] = secret
    }
    return out
  } catch {
    return {}
  }
}

async function writeEncodedSecrets(secrets: Record<string, EncodedRestoreSecret>): Promise<void> {
  const entries = Object.entries(secrets).filter(([, value]) => Object.keys(value).length > 0)
  if (entries.length === 0) {
    try {
      await fs.unlink(secretStoreFile())
    } catch {
      /* missing is fine */
    }
    return
  }
  const tmp = secretStoreFile() + '.tmp'
  await fs.writeFile(
    tmp,
    JSON.stringify({ version: 1, secrets: Object.fromEntries(entries) }, null, 2),
    { encoding: 'utf8', mode: 0o600 }
  )
  await fs.rename(tmp, secretStoreFile())
  await fs.chmod(secretStoreFile(), 0o600).catch(() => {})
}

function hasSecret(secret: RestoreSecret | undefined): boolean {
  return (
    !!secret && Object.values(secret).some((value) => typeof value === 'string' && value !== '')
  )
}

function cleanHop(value: unknown): SessionRestoreSshHop | undefined {
  if (!value || typeof value !== 'object') return undefined
  const hop = value as Record<string, unknown>
  if (typeof hop.host !== 'string' || typeof hop.username !== 'string') return undefined
  return {
    host: hop.host.slice(0, 2048),
    port: finitePort(hop.port),
    username: hop.username.slice(0, 512),
    authMethod: isAuthMethod(hop.authMethod) ? hop.authMethod : 'none',
    privateKeyPath:
      typeof hop.privateKeyPath === 'string' ? hop.privateKeyPath.slice(0, 4096) : undefined,
    hasPassphrase: hop.hasPassphrase === true ? true : undefined
  }
}

function cleanSshDraft(value: unknown): SessionRestoreSshDraft | undefined {
  const hop = cleanHop(value)
  if (!hop) return undefined
  const raw = value as Record<string, unknown>
  const jump = cleanHop(raw.jump)
  return {
    ...hop,
    jump,
    secretId: typeof raw.secretId === 'string' ? raw.secretId.slice(0, 128) : undefined
  }
}

function cleanBrowserTabs(value: unknown): SessionRestoreBrowserTab[] | undefined {
  if (!Array.isArray(value)) return undefined
  const tabs = value.slice(0, 64).flatMap((tab) => {
    if (!tab || typeof tab !== 'object') return []
    const raw = tab as Record<string, unknown>
    if (typeof raw.url !== 'string' || !raw.url.trim()) return []
    const zoom =
      typeof raw.zoom === 'number' && Number.isFinite(raw.zoom)
        ? Math.max(0.5, Math.min(3, raw.zoom))
        : undefined
    return [
      {
        url: raw.url.slice(0, 8192),
        title: typeof raw.title === 'string' ? raw.title.slice(0, 512) : undefined,
        zoom,
        muted: raw.muted === true ? true : undefined
      }
    ]
  })
  return tabs.length > 0 ? tabs : undefined
}

function cleanIndex(value: unknown, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.max(0, Math.min(max, Math.floor(value)))
}

function hydrateSecret(encoded: EncodedRestoreSecret | undefined): RestoreSecret | undefined {
  if (!encoded) return undefined
  const secret: RestoreSecret = {
    password: decryptSecret(encoded.password),
    passphrase: decryptSecret(encoded.passphrase),
    jumpPassword: decryptSecret(encoded.jumpPassword),
    jumpPassphrase: decryptSecret(encoded.jumpPassphrase)
  }
  return hasSecret(secret) ? secret : undefined
}

async function hydrateSnapshot(snapshot: SessionRestoreSnapshot): Promise<SessionRestoreSnapshot> {
  const encoded = await readEncodedSecrets()
  return {
    ...snapshot,
    groups: snapshot.groups.map((group) => ({
      ...group,
      items: group.items.map((item) => {
        const draft = cleanSshDraft(item.sshDraft)
        const secret = draft?.secretId ? hydrateSecret(encoded[draft.secretId]) : undefined
        return {
          ...item,
          browserTabs: cleanBrowserTabs(item.browserTabs),
          browserActiveTab: cleanIndex(item.browserActiveTab, 63),
          scrollback:
            typeof item.scrollback === 'string'
              ? trimSessionScrollback(item.scrollback)
              : undefined,
          sshDraft: draft
            ? {
                ...draft,
                restoreSecret: secret
              }
            : undefined
        }
      })
    }))
  }
}

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
    return isValidSnapshot(parsed) ? hydrateSnapshot(parsed) : null
  } catch {
    return null
  }
}

async function writeSnapshot(snap: SessionRestoreSnapshot): Promise<void> {
  const tmp = storeFile() + '.tmp'
  await fs.writeFile(tmp, JSON.stringify(snap, null, 2), { encoding: 'utf8', mode: 0o600 })
  await fs.rename(tmp, storeFile())
  await fs.chmod(storeFile(), 0o600).catch(() => {})
}

let mutationQueue: Promise<unknown> = Promise.resolve()

function enqueueMutation<T>(op: () => Promise<T>): Promise<T> {
  const next = mutationQueue.then(op, op)
  mutationQueue = next.catch(() => undefined)
  return next
}

export function registerSessionRestoreIpc(): void {
  ipcMain.handle(IPC.sessionRestoreLoad, () => readSnapshot())

  ipcMain.handle(IPC.sessionRestoreSave, (_e, snap: SessionRestoreSnapshot) =>
    enqueueMutation(async () => {
      if (!isValidSnapshot(snap)) return

      const encodedSecrets = await readEncodedSecrets()
      const referencedSecrets = new Set<string>()
      let remainingScrollbackBytes = MAX_TOTAL_PERSISTED_SCROLLBACK_BYTES

      // Cap size: drop groups with no items; keep at most 20 groups / 64 items each.
      const groups = snap.groups
        .filter((g) => Array.isArray(g.items) && g.items.length > 0)
        .slice(0, 20)
        .map((g) => ({
          name: typeof g.name === 'string' && g.name.trim() ? g.name.trim() : 'Terminals',
          items: g.items.slice(0, 64).map((it) => {
            const draft = cleanSshDraft(it.sshDraft)
            if (draft?.secretId) referencedSecrets.add(draft.secretId)

            if (draft && hasSecret(it.sshDraft?.restoreSecret)) {
              const secretId = draft.secretId ?? randomUUID()
              const runtime = it.sshDraft?.restoreSecret
              const encrypted: EncodedRestoreSecret = {}
              for (const key of [
                'password',
                'passphrase',
                'jumpPassword',
                'jumpPassphrase'
              ] as const) {
                const stored = encryptSecret(runtime?.[key])
                if (stored) encrypted[key] = stored
              }
              if (Object.keys(encrypted).length > 0) {
                encodedSecrets[secretId] = encrypted
                draft.secretId = secretId
                referencedSecrets.add(secretId)
              }
            }

            const live =
              typeof it.liveSessionId === 'string'
                ? globalOutputRings.replayForSession(it.liveSessionId)
                : ''
            const sourceScrollback =
              live || (typeof it.scrollback === 'string' ? it.scrollback : '')
            const scrollback =
              sourceScrollback && remainingScrollbackBytes > 0
                ? trimSessionScrollback(
                    sourceScrollback,
                    DEFAULT_PERSISTED_SCROLLBACK_LINES,
                    Math.min(MAX_PERSISTED_SCROLLBACK_BYTES, remainingScrollbackBytes)
                  )
                : undefined
            if (scrollback) {
              remainingScrollbackBytes -= Buffer.byteLength(scrollback, 'utf8')
            }

            return {
              id: String(it.id),
              kind:
                it.kind === 'remote'
                  ? ('remote' as const)
                  : it.kind === 'browser'
                    ? ('browser' as const)
                    : ('local' as const),
              connectionId: typeof it.connectionId === 'string' ? it.connectionId : undefined,
              sshDraft: draft,
              cwd: typeof it.cwd === 'string' ? it.cwd.slice(0, 8192) : undefined,
              title: typeof it.title === 'string' ? it.title.slice(0, 512) : undefined,
              url: typeof it.url === 'string' ? it.url.slice(0, 8192) : undefined,
              browserTabs: cleanBrowserTabs(it.browserTabs),
              browserActiveTab: cleanIndex(it.browserActiveTab, 63),
              scrollback,
              agentKind: typeof it.agentKind === 'string' ? it.agentKind : undefined,
              agentUiMode: typeof it.agentUiMode === 'string' ? it.agentUiMode : undefined
            }
          }),
          layout: g.layout ?? null
        }))
        .filter((g) => g.items.length > 0)

      // Editors reference item ids within the same snapshot; keep them small.
      const editors = Array.isArray(snap.editors)
        ? snap.editors
            .slice(0, 64)
            .filter((ed) => ed && typeof ed.path === 'string')
            .map((ed) => ({
              scope: ed.scope === 'remote' ? ('remote' as const) : ('local' as const),
              itemId: typeof ed.itemId === 'string' ? ed.itemId : undefined,
              path: ed.path.slice(0, 8192)
            }))
        : undefined
      const cleaned: SessionRestoreSnapshot = {
        version: 1,
        savedAt: typeof snap.savedAt === 'number' ? snap.savedAt : Date.now(),
        groups,
        activeGroupIndex:
          typeof snap.activeGroupIndex === 'number' ? snap.activeGroupIndex : undefined,
        editors: editors?.length ? editors : undefined
      }

      for (const id of Object.keys(encodedSecrets)) {
        if (!referencedSecrets.has(id)) delete encodedSecrets[id]
      }
      await writeEncodedSecrets(encodedSecrets)
      await writeSnapshot(cleaned)
    })
  )

  ipcMain.handle(IPC.sessionRestoreClear, () =>
    enqueueMutation(async () => {
      for (const file of [storeFile(), secretStoreFile()]) {
        try {
          await fs.unlink(file)
        } catch {
          /* missing is fine */
        }
      }
    })
  )
}
