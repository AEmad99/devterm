import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { SearchIndex } from './index'

describe('SearchIndex streaming ingestion', () => {
  it('assembles actual lines across transport chunks', () => {
    const index = new SearchIndex()
    index.setSessionTitle('s1', 'Shell')
    index.pushLine('s1', 'first par')
    index.pushLine('s1', 't\r\nsecond\n')

    assert.deepEqual(
      index.query('part').map((x) => x.text),
      ['first part']
    )
    assert.deepEqual(
      index.query('second').map((x) => x.text),
      ['second']
    )
  })

  it('keeps only the final carriage-return redraw', () => {
    const index = new SearchIndex()
    index.pushLine('s1', '10%\r50%\r100%\n')

    assert.equal(index.query('10%').length, 0)
    assert.equal(index.query('50%').length, 0)
    assert.equal(index.query('100%')[0]?.text, '100%')
  })

  it('retains a fixed-size chronological ring with monotonic line numbers', () => {
    const index = new SearchIndex()
    for (let i = 0; i < 2_010; i++) index.pushLine('s1', `row-${i}\n`)

    assert.equal(index.query('row-', 3)[0]?.text, 'row-10')
    assert.equal(index.query('row-', 3)[0]?.lineNumber, 11)
    assert.equal(index.query('row-0').length, 0)
  })
})
