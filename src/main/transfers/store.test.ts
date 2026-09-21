import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import type { TransferItemV2 } from '@shared/types'
import { TransferStore } from './store'

function item(patch: Partial<TransferItemV2> = {}): TransferItemV2 {
  return {
    id: 't-1',
    direction: 'download',
    sessionId: 'ssh-1',
    localPath: '/tmp/a.bin',
    remotePath: '/home/a.bin',
    total: 1000,
    transferred: 400,
    done: false,
    enqueuedAt: 1,
    ...patch
  }
}

describe('TransferStore rehydrate', () => {
  const dirs: string[] = []
  after(async () => {
    await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })))
  })

  it('marks in-flight rows paused and keeps the persisted offset', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dt-xfer-'))
    dirs.push(dir)
    await writeFile(join(dir, 'transfers.json'), JSON.stringify([item()]), 'utf8')

    const store = new TransferStore(dir)
    const loaded = await store.load()
    assert.equal(loaded.length, 1)
    assert.equal(loaded[0].paused, true)
    assert.equal(loaded[0].done, false)
    assert.equal(loaded[0].canceled, undefined)
    assert.equal(loaded[0].transferred, 400)
    assert.notEqual(loaded[0].error, 'interrupted by restart')

    const raw = JSON.parse(await readFile(join(dir, 'transfers.json'), 'utf8')) as TransferItemV2[]
    assert.equal(raw[0].paused, true)
    assert.equal(raw[0].transferred, 400)
  })

  it('leaves finished and canceled rows alone', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dt-xfer-'))
    dirs.push(dir)
    await writeFile(
      join(dir, 'transfers.json'),
      JSON.stringify([
        item({ id: 'done', done: true, transferred: 1000, finishedAt: 2 }),
        item({ id: 'cancel', done: true, canceled: true, error: 'canceled', transferred: 10 })
      ]),
      'utf8'
    )
    const store = new TransferStore(dir)
    const loaded = await store.load()
    assert.equal(loaded.find((x) => x.id === 'done')?.paused, undefined)
    assert.equal(loaded.find((x) => x.id === 'cancel')?.canceled, true)
  })
})
