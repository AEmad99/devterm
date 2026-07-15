import { describe, it } from 'node:test'
import assert from 'node:assert'
// Importing the modal pulls in React + DOMPurify; we want the pure helper.
// It's a named export, so a direct import works.
import { extractCommandPrefix } from './ConfirmActionModal'

/**
 * The "Remember my choice" checkbox in ConfirmActionModal turns an approved
 * run_command into an `allow` rule for future invocations. The prefix must
 * be a meaningful, stable substring of the command — path-like tokens
 * (`./deploy.sh`, `bin/migrate`) must be preserved, but flags and one-off
 * arguments should not anchor the rule to a single call.
 */

describe('extractCommandPrefix', () => {
  it('returns undefined for empty detail', () => {
    assert.strictEqual(extractCommandPrefix('run_command', ''), undefined)
    assert.strictEqual(extractCommandPrefix('run_command', '   '), undefined)
  })

  it('uses the first token when no stable prefix is found', () => {
    assert.strictEqual(extractCommandPrefix('run_command', '--flag'), '--flag')
  })

  it('keeps path-like tokens (./deploy.sh)', () => {
    // Regression: this used to drop everything containing `/`.
    assert.strictEqual(extractCommandPrefix('run_command', './deploy.sh prod'), './deploy.sh prod')
  })

  it('keeps path-like tokens (bin/migrate)', () => {
    assert.strictEqual(
      extractCommandPrefix('run_command', 'bin/migrate --to=2'),
      'bin/migrate'
    )
  })

  it('keeps scripts/run style paths', () => {
    assert.strictEqual(
      extractCommandPrefix('run_command', 'scripts/run --verbose'),
      'scripts/run'
    )
  })

  it('drops flag-like arguments', () => {
    assert.strictEqual(extractCommandPrefix('run_command', 'ls -la /tmp'), 'ls /tmp')
  })

  it('caps at 2 tokens', () => {
    assert.strictEqual(
      extractCommandPrefix('run_command', 'docker run -d nginx:latest'),
      'docker run'
    )
  })

  it('caps total length at 80 chars', () => {
    const long = 'a'.repeat(100)
    const out = extractCommandPrefix('run_command', long)
    assert.ok(out && out.length <= 80)
  })

  it('drops shell metacharacter tokens and keeps the first stable command', () => {
    // `&&` is a metachar; the first stable token pair is `echo hi`.
    assert.strictEqual(extractCommandPrefix('run_command', '&& echo hi'), 'echo hi')
  })

  it('for write_file, the file path is the prefix (bytes stripped)', () => {
    assert.strictEqual(
      extractCommandPrefix('write_file', '/etc/nginx.conf (1234 bytes)'),
      '/etc/nginx.conf'
    )
  })

  it('for write_file with no byte suffix, returns the path as-is', () => {
    assert.strictEqual(extractCommandPrefix('write_file', '/tmp/x'), '/tmp/x')
  })

  it('for unknown tool, trims to 80 chars', () => {
    const out = extractCommandPrefix('other', '  hello world  ')
    assert.strictEqual(out, 'hello world')
  })
})
