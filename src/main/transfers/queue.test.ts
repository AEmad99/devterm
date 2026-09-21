import assert from 'node:assert/strict'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import type { Stats, SFTPWrapper } from 'ssh2'
import { TransferQueue } from './queue'
import { TransferStore } from './store'

function sftpStats(size: number, mtimeSec: number): Stats {
  return { size, mtime: mtimeSec, atime: mtimeSec, mode: 0o100644 } as Stats
}

function fakeSftp(remoteRoot: string): SFTPWrapper {
  const resolve = (p: string) => join(remoteRoot, p.replace(/^[\\/]+/, ''))
  const asStats = (st: { size: number; mtimeMs: number }) =>
    sftpStats(st.size, Math.floor(st.mtimeMs / 1000))

  return {
    stat: (path: string, cb: (err: Error | undefined, stats: Stats) => void) => {
      void stat(resolve(path)).then(
        (st) => cb(undefined, asStats(st)),
        (err) => cb(err as Error, undefined as unknown as Stats)
      )
    },
    lstat: (path: string, cb: (err: Error | undefined, stats: Stats) => void) => {
      void stat(resolve(path)).then(
        (st) => cb(undefined, asStats(st)),
        (err) => cb(err as Error, undefined as unknown as Stats)
      )
    },
    createReadStream: (path: string, opts?: { start?: number }) =>
      createReadStream(resolve(path), opts) as unknown as ReturnType<
        SFTPWrapper['createReadStream']
      >,
    createWriteStream: (path: string, opts?: { start?: number; flags?: string }) =>
      createWriteStream(resolve(path), {
        flags: opts?.flags ?? 'w',
        start: opts?.start
      }) as unknown as ReturnType<SFTPWrapper['createWriteStream']>,
    rename: (from: string, to: string, cb: (err?: Error) => void) => {
      void rename(resolve(from), resolve(to)).then(
        () => cb(),
        (err) => cb(err as Error)
      )
    },
    unlink: (path: string, cb: (err?: Error) => void) => {
      void unlink(resolve(path)).then(
        () => cb(),
        (err) => cb(err as Error)
      )
    }
  } as unknown as SFTPWrapper
}

describe('TransferQueue offset resume', () => {
  const dirs: string[] = []
  after(async () => {
    await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })))
  })

  it('continues a download from the persisted offset and finalizes the partial', async () => {
    const dir = await mkdtempDir()
    const remoteDir = join(dir, 'remote')
    const localDir = join(dir, 'local')
    await Promise.all([mkdir(remoteDir), mkdir(localDir)])
    const remotePath = '/payload.bin'
    const localPath = join(localDir, 'payload.bin')
    const payload = Buffer.from('abcdefghij')
    await writeFile(join(remoteDir, 'payload.bin'), payload)
    const remoteStat = await stat(join(remoteDir, 'payload.bin'))
    await writeFile(localPath + '.partial', payload.subarray(0, 4))

    const store = new TransferStore(dir)
    await store.add({
      id: 't-resume',
      direction: 'download',
      sessionId: 'ssh-1',
      localPath,
      remotePath,
      partialPath: localPath + '.partial',
      total: payload.length,
      transferred: 4,
      sourceSize: payload.length,
      sourceMtimeSec: Math.floor(remoteStat.mtimeMs / 1000),
      done: false,
      paused: true,
      enqueuedAt: Date.now()
    })

    const queue = new TransferQueue(store, async () => fakeSftp(remoteDir))
    const done = new Promise<void>((resolve, reject) => {
      queue.subscribe({
        onItemEvent: (_item, ev) => {
          if (ev.kind === 'done') {
            if (ev.error) reject(new Error(ev.error))
            else resolve()
          }
        },
        onListChanged: () => undefined
      })
    })
    const resumed = await queue.resume('t-resume')
    assert.ok(resumed)
    await done

    assert.equal((await readFile(localPath)).toString(), 'abcdefghij')
    const final = store.get('t-resume')
    assert.equal(final?.done, true)
    assert.equal(final?.transferred, 10)
    await assert.rejects(stat(localPath + '.partial'))
  })

  it('refuses to resume when the remote source mtime/size changed', async () => {
    const dir = await mkdtempDir()
    const remoteDir = join(dir, 'remote')
    const localDir = join(dir, 'local')
    await Promise.all([mkdir(remoteDir), mkdir(localDir)])
    const localPath = join(localDir, 'payload.bin')
    await writeFile(join(remoteDir, 'payload.bin'), Buffer.from('abcdefghij'))
    await writeFile(localPath + '.partial', Buffer.from('abcd'))

    const store = new TransferStore(dir)
    await store.add({
      id: 't-stale',
      direction: 'download',
      sessionId: 'ssh-1',
      localPath,
      remotePath: '/payload.bin',
      partialPath: localPath + '.partial',
      total: 10,
      transferred: 4,
      sourceSize: 10,
      sourceMtimeSec: 1,
      done: false,
      paused: true,
      enqueuedAt: Date.now()
    })

    const queue = new TransferQueue(store, async () => fakeSftp(remoteDir))
    await queue.resume('t-stale')
    for (let i = 0; i < 20; i++) {
      const row = store.get('t-stale')
      if (row?.error) {
        assert.equal(row.paused, true)
        assert.match(String(row.error), /Remote file changed/)
        assert.equal((await readFile(localPath + '.partial')).toString(), 'abcd')
        return
      }
      await new Promise((r) => setTimeout(r, 25))
    }
    assert.fail('expected a paused error after a stale remote fingerprint')
  })

  it('does not double-finish a canceled pending item', async () => {
    const dir = await mkdtempDir()
    const store = new TransferStore(dir)
    const pendingSftp: Array<(err: Error) => void> = []
    const queue = new TransferQueue(
      store,
      () =>
        new Promise((_, reject) => {
          pendingSftp.push(reject)
        })
    )
    const first = queue.enqueue({
      sessionId: 'ssh-1',
      direction: 'download',
      localPath: join(dir, 'a.bin'),
      remotePath: '/a.bin'
    })
    const second = queue.enqueue({
      sessionId: 'ssh-1',
      direction: 'download',
      localPath: join(dir, 'b.bin'),
      remotePath: '/b.bin'
    })
    const third = queue.enqueue({
      sessionId: 'ssh-1',
      direction: 'download',
      localPath: join(dir, 'c.bin'),
      remotePath: '/c.bin'
    })
    await queue.cancel(third.id)
    await queue.cancel(third.id)
    const row = store.get(third.id)
    assert.equal(row?.canceled, true)
    assert.equal(row?.done, true)
    assert.equal(store.get(first.id)?.done, false)
    assert.equal(store.get(second.id)?.done, false)
    queue.shutdown()
    for (const reject of pendingSftp) reject(new Error('shutdown'))
  })

  async function mkdtempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'dt-q-'))
    dirs.push(dir)
    return dir
  }
})
