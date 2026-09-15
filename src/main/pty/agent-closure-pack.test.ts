import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

const require = createRequire(import.meta.url)
const { mirrorAgentClosure } = require('../../../scripts/agent-closure-pack.cjs') as {
  mirrorAgentClosure: (projectDir: string, appOutDir: string) => number
}

const NESTED = join('node_modules', '@earendil-works', 'pi-coding-agent', 'node_modules')

describe('Agent nested-closure packaging', () => {
  it('merges the dev nested closure into app.asar.unpacked', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'agent-closure-src-'))
    const appOutDir = mkdtempSync(join(tmpdir(), 'agent-closure-dst-'))
    try {
      const srcPkg = join(projectDir, NESTED, 'typebox')
      mkdirSync(srcPkg, { recursive: true })
      writeFileSync(join(srcPkg, 'package.json'), JSON.stringify({ name: 'typebox' }))
      // Simulate a nested dep the builder did collect on its own.
      const stalePkg = join(
        appOutDir,
        'resources',
        'app.asar.unpacked',
        NESTED,
        'semver'
      )
      mkdirSync(stalePkg, { recursive: true })
      writeFileSync(join(stalePkg, 'package.json'), JSON.stringify({ name: 'semver' }))

      const mirrored = mirrorAgentClosure(projectDir, appOutDir)

      const dest = join(appOutDir, 'resources', 'app.asar.unpacked', NESTED)
      assert.ok(existsSync(join(dest, 'typebox', 'package.json')))
      assert.ok(existsSync(join(stalePkg, 'package.json')))
      assert.equal(mirrored, readdirSync(dest).length)
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
      rmSync(appOutDir, { recursive: true, force: true })
    }
  })

  it('fails the build when the source closure is missing', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'agent-closure-missing-'))
    const appOutDir = mkdtempSync(join(tmpdir(), 'agent-closure-dst-'))
    try {
      assert.throws(() => mirrorAgentClosure(projectDir, appOutDir), /agent nested closure/)
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
      rmSync(appOutDir, { recursive: true, force: true })
    }
  })
})
