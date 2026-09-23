import { existsSync, statSync } from 'fs'
import { dirname, join } from 'path'
import { app, nativeImage, type NativeImage } from 'electron'

function isFile(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isFile()
  } catch {
    return false
  }
}

/**
 * Resolve the DevTerm logo on disk. Packaged builds copy icon.png/icon.ico into
 * process.resourcesPath (extraResources) and next to the exe (extraFiles).
 */
function candidates(name: string): string[] {
  const execDir = dirname(process.execPath)
  const packed = [
    join(process.resourcesPath, name),
    join(process.resourcesPath, 'resources', name),
    join(execDir, name),
    join(app.getAppPath(), 'resources', name),
    join(app.getAppPath(), name)
  ]
  const unpacked = [
    join(process.cwd(), 'resources', name),
    join(__dirname, '../../resources', name)
  ]
  return app.isPackaged ? packed : [...unpacked, ...packed]
}

/**
 * Path to the app logo. On Windows, prefer the multi-size `.ico` — Electron and
 * the shell use those sizes for the taskbar/titlebar. PNG is preferred elsewhere
 * (notifications, Linux) where NativeImage/ICO support is weaker.
 */
export function resolveAppIconPath(): string | undefined {
  const names =
    process.platform === 'win32' ? (['icon.ico', 'icon.png'] as const) : (['icon.png', 'icon.ico'] as const)
  for (const name of names) {
    for (const p of candidates(name)) {
      if (isFile(p)) return p
    }
  }
  return undefined
}

export function loadAppIcon(): NativeImage | undefined {
  const path = resolveAppIconPath()
  if (!path) return undefined
  const img = nativeImage.createFromPath(path)
  return img.isEmpty() ? undefined : img
}
