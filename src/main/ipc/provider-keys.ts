import { ipcMain } from 'electron'
import { IPC } from '@shared/types'
import { listProviderKeys, setProviderKey, clearProviderKey } from '../provider-keys'

/**
 * Provider API key IPC. Mirrors `src/main/ipc/connections.ts:70-89`: a single
 * `registerXxxIpc()` returning no controller (the data lives in main).
 *
 * Renderer can `list` (id + isSet only), `set` (store a plaintext), and
 * `clear` (drop the plaintext). There is intentionally no `get` exposed to
 * the renderer — the plaintext only flows back into the agent PTY env at
 * launch time via `envForAgent()` in `provider-keys.ts`.
 */
export function registerProviderKeysIpc(): void {
  ipcMain.handle(IPC.providerKeysList, async () => listProviderKeys())
  ipcMain.handle(IPC.providerKeysSet, async (_e, id: string, key: string) => {
    if (typeof id !== 'string' || typeof key !== 'string') {
      throw new Error('providerKeys.set: id and key must be strings')
    }
    await setProviderKey(id, key)
  })
  ipcMain.handle(IPC.providerKeysClear, async (_e, id: string) => {
    if (typeof id !== 'string') throw new Error('providerKeys.clear: id must be a string')
    await clearProviderKey(id)
  })
}
