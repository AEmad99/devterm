import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, it } from 'node:test'
import { resolveSafePath, startFolderServer } from './static-server'

describe('preview static server', () => {
  it('rejects path traversal', () => {
    const root = join(tmpdir(), 'dt-preview-root')
    assert.equal(resolveSafePath(root, '/../../etc/passwd'), null)
  })

  it('serves index.html from a local folder on loopback', async () => {
    const dir = join(tmpdir(), `dt-preview-${Date.now()}`)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'index.html'), '<h1>preview-ok</h1>', 'utf8')
    const serve = await startFolderServer(dir)
    try {
      assert.match(serve.url, /^http:\/\/127\.0\.0\.1:\d+\//)
      const res = await fetch(serve.url)
      const body = await res.text()
      assert.equal(res.status, 200)
      assert.match(body, /preview-ok/)
    } finally {
      await serve.close()
    }
  })
})
