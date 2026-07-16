import { describe, it } from 'node:test'
import assert from 'node:assert'
import { stripAnsi } from './ansi'

/**
 * The global search index stores raw PTY/SSH chunks. Without cleaning, result
 * rows render the terminal's escape sequences verbatim (`[93m`, `[23;20H`,
 * `]7;file://…`). These tests pin `stripAnsi` against the sequence shapes
 * DevTerm's shells actually emit (SGR colors, cursor moves, the OSC 7/133
 * prompt hooks, PowerShell/PSReadLine redraws) so rows come out as plain text.
 */

describe('stripAnsi', () => {
  it('leaves plain text untouched', () => {
    assert.strictEqual(stripAnsi('total 42 files'), 'total 42 files')
  })

  it('strips SGR color codes', () => {
    assert.strictEqual(
      stripAnsi('\x1b[1;32muser@host\x1b[0m:\x1b[94m~\x1b[0m$ ls'),
      'user@host:~$ ls'
    )
  })

  it('strips cursor-positioning and other CSI finals', () => {
    assert.strictEqual(stripAnsi('\x1b[23;20Hresult\x1b[K'), 'result')
    // Private-mode CSI (show/hide cursor) wraps PSReadLine redraws.
    assert.strictEqual(stripAnsi('\x1b[?25ltyping\x1b[?25h'), 'typing')
  })

  it('strips OSC 7 cwd sequences terminated by BEL and ST', () => {
    assert.strictEqual(stripAnsi('\x1b]7;file://DESKTOP-A1B2C3/D:/projects/DevTerm\x07'), '')
    assert.strictEqual(stripAnsi('\x1b]7;file:///home/user\x1b\\rest of line'), 'rest of line')
  })

  it('strips OSC 133 prompt markers', () => {
    assert.strictEqual(stripAnsi('\x1b]133;A\x07$ \x1b]133;B\x07ls -la'), '$ ls -la')
  })

  it('cleans a PowerShell prompt line', () => {
    const raw = '\x1b[?25l\x1b[93mPS C:\\Users\\dev\x1b[0m\x1b[1;33m ❯\x1b[0m \x1b[?25h'
    assert.strictEqual(stripAnsi(raw), 'PS C:\\Users\\dev ❯ ')
  })

  it('strips stray ESC sequences (charset select, DECSC/DECRC)', () => {
    assert.strictEqual(stripAnsi('\x1b(B\x1b7hi\x1b8'), 'hi')
  })

  it('strips an unterminated OSC at the end of a chunk', () => {
    assert.strictEqual(stripAnsi('output\x1b]0;half-written title'), 'output')
  })

  it('drops C0 control chars but keeps tabs', () => {
    assert.strictEqual(stripAnsi('a\x07b\x00c\td\x7fe'), 'abc\tde')
  })

  it('drops CR/LF so a chunk stays a single result row', () => {
    assert.strictEqual(stripAnsi('one\r\ntwo\rthree'), 'onetwothree')
  })

  it('returns an empty string for a pure escape-sequence chunk', () => {
    assert.strictEqual(stripAnsi('\x1b]7;file:///home/user\x07\x1b[2K\r'), '')
  })
})
