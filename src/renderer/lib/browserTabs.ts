/**
 * Routes "open a new window" requests from in-app browser guests (target=_blank,
 * window.open, "open in new tab") into a new tab of the pane that owns the guest.
 *
 * Main denies the native popup and sends `browser:open-tab` with the originating
 * guest's webContents id (see src/main/index.ts). Each browser tab registers its
 * guest's webContents id here against its pane's "add tab" function, so we can open
 * the new tab in the correct pane. A single IPC subscription fans out to all panes.
 */
type Opener = (url: string) => void

const openers = new Map<number, Opener>()
let wired = false

function ensureWired(): void {
  if (wired) return
  wired = true
  window.devterm.browser.onOpenTab(({ sourceId, url }) => {
    openers.get(sourceId)?.(url)
  })
}

/** Register a guest webContents id → its pane's add-tab opener. Returns an unregister fn. */
export function registerBrowserGuest(webContentsId: number, open: Opener): () => void {
  ensureWired()
  openers.set(webContentsId, open)
  return () => {
    openers.delete(webContentsId)
  }
}
