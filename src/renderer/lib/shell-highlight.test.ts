import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { tokenizeShell } from './shell-highlight'

function kinds(input: string, dialect: 'shell' | 'powershell' = 'shell') {
  return tokenizeShell(input, dialect)
    .filter((t) => t.kind !== 'text' || t.text.trim())
    .map((t) => `${t.kind}:${t.text}`)
}

describe('tokenizeShell', () => {
  it('highlights git commit style tokens', () => {
    const got = kinds('git commit -m "fix bug"')
    assert.deepEqual(got, ['command:git', 'text:commit', 'flag:-m', 'string:"fix bug"'])
  })

  it('treats pipes as a new command', () => {
    const got = kinds('ls -la | grep foo')
    assert.deepEqual(got, ['command:ls', 'flag:-la', 'operator:|', 'command:grep', 'text:foo'])
  })

  it('marks comments', () => {
    const got = kinds('echo hi # note')
    assert.ok(got.some((t) => t.startsWith('comment:')))
  })

  it('highlights powershell flags and quoted strings', () => {
    const got = kinds('Get-ChildItem -Path "C:\\tmp"', 'powershell')
    assert.ok(got[0] === 'command:Get-ChildItem')
    assert.ok(got.some((t) => t.startsWith('flag:-Path')))
    assert.ok(got.some((t) => t.startsWith('string:')))
  })
})
