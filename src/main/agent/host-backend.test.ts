import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { LocalHostBackend } from './host-backend'

const cwdProbe = process.platform === 'win32' ? 'cd' : 'pwd'

function normalized(p: string): string {
  return p
    .trim()
    .replace(/[\\/]+$/, '')
    .toLowerCase()
}

describe('LocalHostBackend cwd', () => {
  it("runs commands in the operator's terminal directory when a cwd is passed", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'devterm-cwd-test-'))
    try {
      const backend = new LocalHostBackend()
      const res = await backend.exec(cwdProbe, 10000, dir)
      assert.equal(res.code, 0)
      assert.equal(normalized(res.stdout), normalized(dir))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps the process working directory when no cwd is passed', async () => {
    const backend = new LocalHostBackend()
    const res = await backend.exec(cwdProbe, 10000)
    assert.equal(res.code, 0)
    assert.equal(normalized(res.stdout), normalized(process.cwd()))
  })
})
