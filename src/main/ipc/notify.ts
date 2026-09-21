import { app, ipcMain, safeStorage } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { IPC, type IdleNotifyEvent, type IdleNotifySecrets } from '@shared/types'

interface StoredSecrets {
  webhookUrl?: string
  telegramBotToken?: string
  telegramChatId?: string
}

function secretsFile(): string {
  return join(app.getPath('userData'), 'notify-secrets.json')
}

function loadSecrets(): StoredSecrets {
  try {
    const raw = JSON.parse(readFileSync(secretsFile(), 'utf8')) as Record<string, string>
    const out: StoredSecrets = {}
    for (const key of ['webhookUrl', 'telegramBotToken', 'telegramChatId'] as const) {
      const v = raw[key]
      if (!v) continue
      if (safeStorage.isEncryptionAvailable() && v.startsWith('enc:')) {
        try {
          out[key] = safeStorage.decryptString(Buffer.from(v.slice(4), 'base64'))
        } catch {
          /* ignore */
        }
      } else if (!v.startsWith('enc:')) {
        out[key] = v
      }
    }
    return out
  } catch {
    return {}
  }
}

function saveSecrets(next: StoredSecrets): void {
  mkdirSync(app.getPath('userData'), { recursive: true })
  const enc = (s?: string) => {
    if (!s) return undefined
    if (safeStorage.isEncryptionAvailable()) {
      return `enc:${safeStorage.encryptString(s).toString('base64')}`
    }
    return s
  }
  writeFileSync(
    secretsFile(),
    JSON.stringify({
      webhookUrl: enc(next.webhookUrl),
      telegramBotToken: enc(next.telegramBotToken),
      telegramChatId: next.telegramChatId
    }),
    { encoding: 'utf8', mode: 0o600 }
  )
}

async function postJson(url: string, body: unknown): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  if (!res.ok) throw new Error(`notify ${res.status}`)
}

export function registerNotifyIpc(): void {
  ipcMain.handle(IPC.notifySecrets, (_e, secrets: IdleNotifySecrets) => {
    const cur = loadSecrets()
    saveSecrets({
      webhookUrl: secrets.webhookUrl?.trim() || cur.webhookUrl,
      telegramBotToken: secrets.telegramBotToken?.trim() || cur.telegramBotToken,
      telegramChatId: secrets.telegramChatId?.trim() || cur.telegramChatId
    })
  })

  ipcMain.handle(IPC.notifyIdle, async (_e, event: IdleNotifyEvent) => {
    const secrets = loadSecrets()
    const text = [event.title, event.body].filter(Boolean).join('\n')
    const jobs: Promise<void>[] = []
    if (secrets.webhookUrl) {
      jobs.push(
        postJson(secrets.webhookUrl, {
          sessionId: event.sessionId,
          reason: event.reason,
          title: event.title,
          body: event.body
        }).catch((err) => {
          console.warn('idle webhook failed', err)
        })
      )
    }
    if (secrets.telegramBotToken && secrets.telegramChatId) {
      const url = `https://api.telegram.org/bot${secrets.telegramBotToken}/sendMessage`
      jobs.push(
        postJson(url, { chat_id: secrets.telegramChatId, text: text.slice(0, 3500) }).catch((err) => {
          console.warn('telegram notify failed', err)
        })
      )
    }
    await Promise.all(jobs)
  })
}
