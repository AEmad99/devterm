import { describe, it } from 'node:test'
import assert from 'node:assert'
import {
  clean,
  historyKey,
  looksSensitive,
  mergeHistory,
  parsePsReadLine,
  splitLines,
  stripZsh,
  type StoredEntry
} from './history-parse'

/**
 * The palette's History category merges DevTerm records with host shell-history
 * files. A mangled row was observed in the wild:
 *   `cd D:\projects\my-termD:\projects\my-term`  (path duplicated and concatenated)
 * alongside near-duplicates `CD D:\projects\my-term\` and `cd 'D:\projects\my-term'`.
 * Root cause: PSReadLine stores multi-line commands with a trailing-backtick
 * continuation (one physical line per segment), but the reader split the file
 * naively on newlines — each fragment became its own "command", and exact-string
 * dedupe let every casing/quoting variant through as a separate row. These tests
 * pin the reassembly parser and the normalised dedupe.
 */

const entry = (command: string, over: Partial<StoredEntry> = {}): StoredEntry => ({
  command,
  count: over.count ?? 1,
  last: over.last ?? 0,
  scope: over.scope ?? 'local'
})

describe('splitLines', () => {
  it('handles LF, CRLF, and lone CR endings', () => {
    assert.deepStrictEqual(splitLines('a\nb'), ['a', 'b'])
    assert.deepStrictEqual(splitLines('a\r\nb'), ['a', 'b'])
    assert.deepStrictEqual(splitLines('a\rb'), ['a', 'b'])
  })

  it('keeps a final line with no trailing newline', () => {
    assert.deepStrictEqual(splitLines('a\nb'), ['a', 'b'])
    assert.deepStrictEqual(splitLines('a\r\nb\r\nc'), ['a', 'b', 'c'])
  })

  it('yields a trailing empty line for a terminated file (filtered downstream)', () => {
    assert.deepStrictEqual(splitLines('a\n'), ['a', ''])
  })
})

describe('parsePsReadLine', () => {
  it('passes single-line commands through', () => {
    assert.deepStrictEqual(parsePsReadLine('git status\r\nnpm run dev\r\n'), [
      'git status',
      'npm run dev',
      ''
    ])
  })

  it('keeps the last entry when the file has no trailing newline', () => {
    assert.deepStrictEqual(parsePsReadLine('git status\r\nnpm run dev'), [
      'git status',
      'npm run dev'
    ])
  })

  it('reassembles a multi-line command (the reported concatenation case)', () => {
    // PSReadLine on-disk form of the two-line command
    //   cd D:\projects\my-term
    //   D:\projects\my-term
    const file = 'cd D:\\projects\\my-term`\r\nD:\\projects\\my-term\r\ngit status\r\n'
    assert.deepStrictEqual(parsePsReadLine(file), [
      'cd D:\\projects\\my-term\nD:\\projects\\my-term',
      'git status',
      ''
    ])
  })

  it('strips exactly one backtick when the command text itself ends with one', () => {
    // A PowerShell line continuation inside the command is written with two
    // backticks (the literal one plus the escape); one must survive.
    const file = 'cd D:\\projects\\my-term``\r\nD:\\projects\\my-term\r\n'
    assert.deepStrictEqual(parsePsReadLine(file), [
      'cd D:\\projects\\my-term`\nD:\\projects\\my-term',
      ''
    ])
  })

  it('reassembles records spanning more than two lines', () => {
    const file = 'foreach ($f in $files) `\r\n{\r\n  echo $f `\r\n}\r\n'
    // Note: only lines ending in a backtick continue; "{" does not.
    assert.deepStrictEqual(parsePsReadLine(file), [
      'foreach ($f in $files) \n{',
      '  echo $f \n}',
      ''
    ])
  })

  it('drops an unterminated continuation at EOF (truncated file)', () => {
    assert.deepStrictEqual(parsePsReadLine('git status\r\ncd D:\\projects\\my-term`'), [
      'git status'
    ])
  })
})

describe('historyKey', () => {
  it('is case-insensitive', () => {
    assert.strictEqual(
      historyKey('CD D:\\projects\\my-term'),
      historyKey('cd d:\\projects\\my-term')
    )
  })

  it('ignores surrounding quotes', () => {
    assert.strictEqual(
      historyKey("cd 'D:\\projects\\my-term'"),
      historyKey('cd D:\\projects\\my-term')
    )
    assert.strictEqual(
      historyKey('cd "D:\\projects\\my-term"'),
      historyKey('cd D:\\projects\\my-term')
    )
  })

  it('ignores a trailing path separator', () => {
    assert.strictEqual(
      historyKey('CD D:\\projects\\my-term\\'),
      historyKey("cd 'D:\\projects\\my-term'")
    )
  })

  it('collapses repeated whitespace', () => {
    assert.strictEqual(historyKey('npm  run   dev'), historyKey('npm run dev'))
  })

  it('keeps genuinely different commands distinct', () => {
    assert.notStrictEqual(historyKey('git status'), historyKey('git stash'))
  })
})

describe('mergeHistory', () => {
  it('produces no mangled rows from the reported PSReadLine file', () => {
    const file = [
      'git status',
      'cd D:\\projects\\my-term`', // multi-line record, part 1
      'D:\\projects\\my-term', // multi-line record, part 2
      'CD D:\\projects\\my-term\\',
      "cd 'D:\\projects\\my-term'",
      'npm run dev'
    ].join('\r\n')
    const { recent, frequent } = mergeHistory(parsePsReadLine(file), [])
    const all = [...recent, ...frequent.map((f) => f.command)]
    // No continuation fragments and no concatenated junk anywhere.
    assert.ok(!all.some((c) => c.endsWith('`')), JSON.stringify(all))
    assert.ok(!all.some((c) => c.includes('\n')), JSON.stringify(all))
    assert.ok(
      !all.some((c) => c === 'cd D:\\projects\\my-termD:\\projects\\my-term'),
      JSON.stringify(all)
    )
    // The three cd variants collapse to a single row.
    const cds = all.filter((c) => historyKey(c) === historyKey('cd D:\\projects\\my-term'))
    assert.strictEqual(new Set(cds).size, 1, JSON.stringify(all))
  })

  it('collapses casing/quoting variants, keeping the most recent variant as display', () => {
    const external = ['CD D:\\projects\\my-term\\', "cd 'D:\\projects\\my-term'"]
    const { recent, frequent } = mergeHistory(external, [])
    assert.deepStrictEqual(recent, ["cd 'D:\\projects\\my-term'"])
    assert.deepStrictEqual(frequent, [{ command: "cd 'D:\\projects\\my-term'", count: 2 }])
  })

  it('lets a newer in-app variant win the display over external history', () => {
    const { recent, frequent } = mergeHistory(['git status'], [entry('GIT status', { last: 10 })])
    assert.deepStrictEqual(recent, ['GIT status'])
    assert.deepStrictEqual(frequent, [{ command: 'GIT status', count: 2 }])
  })

  it('dedupes recent by key even when in-app and external differ only by case', () => {
    const { recent } = mergeHistory(['npm test'], [entry('NPM TEST', { last: 5 })])
    assert.deepStrictEqual(recent, ['NPM TEST'])
  })

  it('excludes multi-line records rather than flattening them', () => {
    const { recent, frequent } = mergeHistory(['echo one\necho two', 'echo three'], [])
    assert.deepStrictEqual(recent, ['echo three'])
    assert.deepStrictEqual(frequent, [{ command: 'echo three', count: 1 }])
  })

  it('still filters sensitive-looking commands and blanks', () => {
    const { recent, frequent } = mergeHistory(
      ['', '   ', 'export TOKEN=abc123', 'git status'],
      [entry('set password=hunter2')]
    )
    assert.deepStrictEqual(recent, ['git status'])
    assert.deepStrictEqual(frequent, [{ command: 'git status', count: 1 }])
  })

  it('sums counts across variants for the frequent list', () => {
    const inApp = [
      entry('git pull', { count: 3, last: 1 }),
      entry('GIT PULL', { count: 2, last: 2 })
    ]
    const { recent, frequent } = mergeHistory(['git pull'], inApp)
    assert.deepStrictEqual(recent, ['GIT PULL']) // newest stored variant wins
    assert.deepStrictEqual(frequent, [{ command: 'GIT PULL', count: 6 }])
  })
})

describe('clean / stripZsh / looksSensitive (moved helpers)', () => {
  it('clean trims whitespace and a trailing CR', () => {
    assert.strictEqual(clean('  git status \r'), 'git status')
  })

  it('stripZsh removes extended-history timestamps only', () => {
    assert.strictEqual(stripZsh(': 1700000000:0;git status'), 'git status')
    assert.strictEqual(stripZsh('git status'), 'git status')
  })

  it('looksSensitive flags secrets and ignores ordinary commands', () => {
    assert.ok(looksSensitive('curl -H "Authorization: Bearer abc" example.com'))
    assert.ok(!looksSensitive('git status'))
  })
})
