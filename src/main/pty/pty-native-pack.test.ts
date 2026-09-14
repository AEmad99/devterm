import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

const require = createRequire(import.meta.url)
const { WIN_PTY_RELEASE_FILES, missingNativeFiles, ensureNodePtyShipsBuild } =
  require('../../../scripts/pty-native-pack.cjs') as {
    WIN_PTY_RELEASE_FILES: string[]
    missingNativeFiles: (dir: string) => string[]
    ensureNodePtyShipsBuild: (projectDir: string) => boolean
  }

describe('Windows node-pty packaging contract', () => {
  it('requires conpty.node (ConPTY) and pty.node (winpty fallback)', () => {
    assert.ok(WIN_PTY_RELEASE_FILES.includes('conpty.node'))
    assert.ok(WIN_PTY_RELEASE_FILES.includes('pty.node'))
    assert.ok(WIN_PTY_RELEASE_FILES.includes('conpty_console_list.node'))
  })

  it('reports every missing Release addon', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pty-native-'))
    try {
      assert.deepEqual(missingNativeFiles(dir), WIN_PTY_RELEASE_FILES)
      writeFileSync(join(dir, 'conpty.node'), '')
      assert.equal(missingNativeFiles(dir).includes('conpty.node'), false)
      assert.ok(missingNativeFiles(dir).includes('pty.node'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('adds build/ to node-pty package.json files when omitted', () => {
    const root = mkdtempSync(join(tmpdir(), 'pty-pkg-'))
    const pkgDir = join(root, 'node_modules', 'node-pty')
    try {
      mkdirSync(pkgDir, { recursive: true })
      writeFileSync(
        join(pkgDir, 'package.json'),
        JSON.stringify({ name: 'node-pty', files: ['lib/', 'src/'] }, null, 2)
      )
      assert.equal(ensureNodePtyShipsBuild(root), true)
      const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as {
        files: string[]
      }
      assert.ok(pkg.files.includes('build/'))
      assert.equal(ensureNodePtyShipsBuild(root), false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
