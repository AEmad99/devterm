import { describe, it } from 'node:test'
import assert from 'node:assert'
import { shQuote, quoteRemotePath, isPosixPath } from './shell-quote'

/**
 * The git layer's remote exec path builds commands like
 *   `cd <quoteRemotePath(cwd)> && git <shQuote(args)>`
 * and runs them on the remote shell. Path arguments must be airtight:
 * a single unescaped quote (or stray `$`) lets a malicious path expand to
 * arbitrary shell. These tests pin the quoting helpers against the edge
 * cases that would otherwise sneak through.
 */

describe('shQuote', () => {
  it('wraps a plain path in single quotes', () => {
    assert.strictEqual(shQuote('/usr/local/bin'), "'/usr/local/bin'")
  })

  it('escapes embedded single quotes (close-escape-reopen pattern)', () => {
    assert.strictEqual(shQuote("it's"), "'it'\\''s'")
  })

  it('preserves $ and backticks literally (single-quoted strings are literal)', () => {
    const out = shQuote('$HOME `uname` \\')
    assert.strictEqual(out, "'$HOME `uname` \\'")
  })

  it('handles an empty string', () => {
    assert.strictEqual(shQuote(''), "''")
  })

  it('handles a path with spaces', () => {
    assert.strictEqual(shQuote('/tmp/my file.txt'), "'/tmp/my file.txt'")
  })
})

describe('isPosixPath', () => {
  it('returns true for / paths', () => {
    assert.strictEqual(isPosixPath('/'), true)
    assert.strictEqual(isPosixPath('/home/user'), true)
    assert.strictEqual(isPosixPath('/tmp/file with spaces'), true)
  })
  it('returns false for Windows-style paths', () => {
    assert.strictEqual(isPosixPath('C:\\Users'), false)
    assert.strictEqual(isPosixPath('D:/x'), false)
  })
  it('returns false for relative paths', () => {
    assert.strictEqual(isPosixPath('foo/bar'), false)
    assert.strictEqual(isPosixPath('./x'), false)
  })
  it('returns false for an empty string', () => {
    assert.strictEqual(isPosixPath(''), false)
  })
})

describe('quoteRemotePath', () => {
  it('PowerShell-quotes Windows-style paths', () => {
    // Non-POSIX paths fall through to psQuote: single-quoted with embedded
    // single quotes doubled (PowerShell escape rule).
    assert.strictEqual(quoteRemotePath('C:\\Users\\x'), "'C:\\Users\\x'")
  })

  it('returns a relative POSIX-looking path as-is (does not start with /)', () => {
    // 'foo/bar' is not a POSIX absolute path, so it goes to psQuote.
    assert.strictEqual(quoteRemotePath('foo/bar'), "'foo/bar'")
  })

  it('quotes absolute POSIX paths with shQuote', () => {
    assert.strictEqual(quoteRemotePath('/tmp/x'), "'/tmp/x'")
  })

  it('handles a path with single quotes', () => {
    assert.strictEqual(quoteRemotePath("/tmp/it's"), "'/tmp/it'\\''s'")
  })

  it('quotes an empty path as a literal empty arg', () => {
    // For empty/non-POSIX paths, quoteRemotePath falls through to psQuote
    // which produces a literal empty single-quoted arg.
    assert.strictEqual(quoteRemotePath(''), "''")
  })
})
