import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { SFTPWrapper } from 'ssh2'
import { SftpWatchManager } from './watch'

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

describe('SftpWatchManager pause/resume', () => {
  it('stops timer polls while paused and refreshes immediately on resume', async () => {
    let readdirCalls = 0
    const sftp = {
      readdir: (_path: string, cb: (err: Error | null, entries: unknown[]) => void) => {
        readdirCalls += 1
        cb(null, [
          {
            filename: 'README.md',
            longname: '-rw-r--r-- 1 devterm devterm 1 Jan 1 00:00 README.md',
            attrs: { mode: 0o100644, size: 1, mtime: 1 }
          }
        ])
      }
    } as unknown as SFTPWrapper
    const manager = new SftpWatchManager(
      async () => sftp,
      () => undefined,
      10
    )

    const id = await manager.start('session-1', '/tmp')
    manager.setPaused(id, true)
    await wait(30)
    assert.equal(readdirCalls, 1, 'pausing should cancel the scheduled poll')

    manager.setPaused(id, false)
    await wait(15)
    assert.ok(readdirCalls >= 2, 'resuming should perform one immediate refresh')
    manager.stop(id)
  })
})
