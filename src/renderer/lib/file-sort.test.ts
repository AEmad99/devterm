import { describe, it } from 'node:test'
import assert from 'node:assert'
import type { FileEntry } from '@shared/types'
import {
  DEFAULT_FILE_SORT,
  fileTypeKey,
  filterFileEntries,
  loadFileSortPrefs,
  sortFileEntries
} from './file-sort'

/**
 * The file views (sidebar explorer + SFTP panes) sort and filter through
 * these helpers. These tests pin the ordering rules: dirs-first grouping,
 * per-key ordering, deterministic name tie-breaks, and substring filtering.
 */

function entry(over: Partial<FileEntry> & { name: string }): FileEntry {
  return {
    path: `/tmp/${over.name}`,
    isDir: false,
    isSymlink: false,
    size: 0,
    mtimeMs: 0,
    mode: '-rw-r--r--',
    ...over
  }
}

const names = (es: FileEntry[]) => es.map((e) => e.name)

describe('fileTypeKey', () => {
  it('returns the lower-cased extension', () => {
    assert.strictEqual(fileTypeKey('Photo.JPG'), 'jpg')
    assert.strictEqual(fileTypeKey('archive.tar.gz'), 'gz')
  })

  it('returns empty for extensionless names, dotfiles, and trailing dots', () => {
    assert.strictEqual(fileTypeKey('Makefile'), '')
    assert.strictEqual(fileTypeKey('.gitignore'), '')
    assert.strictEqual(fileTypeKey('weird.'), '')
  })
})

describe('sortFileEntries', () => {
  const mixed = [
    entry({ name: 'b.txt', size: 20, mtimeMs: 200 }),
    entry({ name: 'docs', isDir: true, size: 0, mtimeMs: 50 }),
    entry({ name: 'a.txt', size: 10, mtimeMs: 300 }),
    entry({ name: 'img.png', size: 30, mtimeMs: 100 })
  ]

  it('defaults to dirs-first name ascending', () => {
    assert.deepStrictEqual(names(sortFileEntries(mixed)), ['docs', 'a.txt', 'b.txt', 'img.png'])
    assert.deepStrictEqual(names(sortFileEntries(mixed, DEFAULT_FILE_SORT)), [
      'docs',
      'a.txt',
      'b.txt',
      'img.png'
    ])
  })

  it('sorts names naturally and case-insensitively', () => {
    const es = [entry({ name: 'file10.txt' }), entry({ name: 'File2.txt' })]
    assert.deepStrictEqual(names(sortFileEntries(es)), ['File2.txt', 'file10.txt'])
  })

  it('mixes dirs and files when dirsFirst is off', () => {
    const out = sortFileEntries(mixed, { key: 'name', dir: 'asc', dirsFirst: false })
    assert.deepStrictEqual(names(out), ['a.txt', 'b.txt', 'docs', 'img.png'])
  })

  it('sorts by size with a name tie-break', () => {
    const es = [
      entry({ name: 'b', size: 10 }),
      entry({ name: 'a', size: 10 }),
      entry({ name: 'c', size: 5 })
    ]
    const out = sortFileEntries(es, { key: 'size', dir: 'asc', dirsFirst: false })
    assert.deepStrictEqual(names(out), ['c', 'a', 'b'])
  })

  it('sorts by modified time', () => {
    const out = sortFileEntries(mixed, { key: 'modified', dir: 'asc', dirsFirst: false })
    assert.deepStrictEqual(names(out), ['docs', 'img.png', 'b.txt', 'a.txt'])
  })

  it('sorts by type (extension), extensionless first', () => {
    const es = [
      entry({ name: 'b.png' }),
      entry({ name: 'Makefile' }),
      entry({ name: 'a.txt' }),
      entry({ name: 'c.png' })
    ]
    const out = sortFileEntries(es, { key: 'type', dir: 'asc', dirsFirst: false })
    assert.deepStrictEqual(names(out), ['Makefile', 'b.png', 'c.png', 'a.txt'])
  })

  it('reverses the whole order (including tie-breaks) when descending', () => {
    const es = [entry({ name: 'a', size: 1 }), entry({ name: 'b', size: 1 })]
    const out = sortFileEntries(es, { key: 'size', dir: 'desc', dirsFirst: false })
    assert.deepStrictEqual(names(out), ['b', 'a'])
    const out2 = sortFileEntries(mixed, { key: 'name', dir: 'desc', dirsFirst: true })
    assert.deepStrictEqual(names(out2), ['docs', 'img.png', 'b.txt', 'a.txt'])
  })

  it('keeps dirs grouped first even when descending', () => {
    const es = [entry({ name: 'aaa' }), entry({ name: 'zzz', isDir: true })]
    const out = sortFileEntries(es, { key: 'name', dir: 'desc', dirsFirst: true })
    assert.deepStrictEqual(names(out), ['zzz', 'aaa'])
  })

  it('does not mutate the input array', () => {
    const before = names(mixed)
    sortFileEntries(mixed, { key: 'size', dir: 'desc', dirsFirst: false })
    assert.deepStrictEqual(names(mixed), before)
  })
})

describe('filterFileEntries', () => {
  const es = [
    entry({ name: 'README.md' }),
    entry({ name: 'src', isDir: true }),
    entry({ name: 'readline.c' })
  ]

  it('returns the input untouched for a blank query', () => {
    assert.strictEqual(filterFileEntries(es, ''), es)
    assert.strictEqual(filterFileEntries(es, '   '), es)
  })

  it('matches case-insensitive substrings', () => {
    assert.deepStrictEqual(names(filterFileEntries(es, 'read')), ['README.md', 'readline.c'])
    assert.deepStrictEqual(names(filterFileEntries(es, 'SRC')), ['src'])
  })

  it('returns an empty array when nothing matches', () => {
    assert.deepStrictEqual(filterFileEntries(es, 'zzz-nope'), [])
  })
})

describe('loadFileSortPrefs', () => {
  it('returns defaults outside a browser (no localStorage)', () => {
    assert.deepStrictEqual(loadFileSortPrefs(), DEFAULT_FILE_SORT)
  })
})
