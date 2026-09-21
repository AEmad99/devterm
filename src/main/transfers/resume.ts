import { promises as fs } from 'fs'
import type { SFTPWrapper } from 'ssh2'
import type { TransferItemV2 } from '@shared/types'
import { deleteRemote, renameRemote, statRemote } from '../ssh/sftp'

/** Destination working copy until the transfer succeeds. */
export function destPartialPath(
  direction: 'upload' | 'download',
  localPath: string,
  remotePath: string
): string {
  const dest = direction === 'download' ? localPath : remotePath
  return dest.endsWith('.partial') ? dest : `${dest}.partial`
}

export function mtimeSecFromMs(mtimeMs: number): number {
  return Math.floor(mtimeMs / 1000)
}

export function verifySourceFingerprint(
  expected: { size?: number; mtimeSec?: number },
  actual: { size: number; mtimeSec: number },
  label: 'Remote' | 'Local'
): string | null {
  if (expected.size == null || expected.mtimeSec == null) return null
  if (actual.size !== expected.size || actual.mtimeSec !== expected.mtimeSec) {
    return `${label} file changed (size or mtime); resume aborted so the existing file is not overwritten`
  }
  return null
}

export function verifyPartialSize(
  bytesDone: number,
  actualSize: number,
  label: string
): string | null {
  if (actualSize !== bytesDone) {
    return `${label} size (${actualSize}) does not match saved progress (${bytesDone}); resume aborted`
  }
  return null
}

export interface PreparedTransfer {
  offset: number
  total: number
  partialPath: string
  sourceSize: number
  sourceMtimeSec: number
}

/**
 * Stat the source, optionally verify a paused partial, and return the byte
 * offset to continue from. Never truncates or overwrites on a mismatch.
 */
export async function prepareTransfer(
  sftp: SFTPWrapper,
  item: TransferItemV2
): Promise<PreparedTransfer> {
  const isDownload = item.direction === 'download'
  const partialPath =
    item.partialPath ?? destPartialPath(item.direction, item.localPath, item.remotePath)
  const resume = item.transferred > 0

  if (isDownload) {
    const remote = await statRemote(sftp, item.remotePath)
    const sourceSize = remote.size ?? 0
    const sourceMtimeSec = remote.mtime ?? 0
    if (resume) {
      const srcErr = verifySourceFingerprint(
        { size: item.sourceSize, mtimeSec: item.sourceMtimeSec },
        { size: sourceSize, mtimeSec: sourceMtimeSec },
        'Remote'
      )
      if (srcErr) throw new Error(srcErr)
      let partialSize: number
      try {
        partialSize = (await fs.stat(partialPath)).size
      } catch {
        throw new Error(`Partial file missing or unreadable (${partialPath}); cannot resume`)
      }
      const sizeErr = verifyPartialSize(item.transferred, partialSize, 'Local partial')
      if (sizeErr) throw new Error(sizeErr)
      return {
        offset: item.transferred,
        total: sourceSize,
        partialPath,
        sourceSize,
        sourceMtimeSec
      }
    }
    return { offset: 0, total: sourceSize, partialPath, sourceSize, sourceMtimeSec }
  }

  const local = await fs.stat(item.localPath)
  const sourceSize = local.size
  const sourceMtimeSec = mtimeSecFromMs(local.mtimeMs)
  if (resume) {
    const srcErr = verifySourceFingerprint(
      { size: item.sourceSize, mtimeSec: item.sourceMtimeSec },
      { size: sourceSize, mtimeSec: sourceMtimeSec },
      'Local'
    )
    if (srcErr) throw new Error(srcErr)
    let remoteSize: number
    try {
      remoteSize = (await statRemote(sftp, partialPath)).size ?? 0
    } catch {
      throw new Error(`Remote partial file missing (${partialPath}); cannot resume`)
    }
    const sizeErr = verifyPartialSize(item.transferred, remoteSize, 'Remote partial')
    if (sizeErr) throw new Error(sizeErr)
    return { offset: item.transferred, total: sourceSize, partialPath, sourceSize, sourceMtimeSec }
  }
  return { offset: 0, total: sourceSize, partialPath, sourceSize, sourceMtimeSec }
}

export async function replaceLocalFile(from: string, to: string): Promise<void> {
  if (from === to) return
  try {
    await fs.unlink(to)
  } catch (e) {
    const err = e as NodeJS.ErrnoException
    if (err.code !== 'ENOENT') throw e
  }
  await fs.rename(from, to)
}

export async function replaceRemoteFile(
  sftp: SFTPWrapper,
  from: string,
  to: string
): Promise<void> {
  if (from === to) return
  try {
    await deleteRemote(sftp, to)
  } catch {
    /* dest missing is fine */
  }
  await renameRemote(sftp, from, to)
}
