import { existsSync } from 'fs'
import { join } from 'path'
import { app, nativeImage, type NativeImage } from 'electron'

/**
 * Resolve the DevTerm logo on disk. Packaged builds ship `icon.ico` / `icon.png`
 * via electron-builder extraResources (process.resourcesPath). Dev and
 * unpackaged runs load the same files from the repo `resources/` folder.
 */
function candidates(name: string): string[] {
  const packed = app.isPackaged
    ? [
        join(process.resourcesPath, name),
        join(process.resourcesPath, 'resources', name),
        join(app.getAppPath(), 'resources', name)
      ]
    : []
  return [
    ...packed,
    join(process.cwd(), 'resources', name),
    join(__dirname, '../../resources', name)
  ]
}

export function resolveAppIconPath(): string | undefined {
  const names = process.platform === 'win32' ? ['icon.ico', 'icon.png'] : ['icon.png', 'icon.ico']
  for (const name of names) {
    for (const p of candidates(name)) {
      if (existsSync(p)) return p
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
