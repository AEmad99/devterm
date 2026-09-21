import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  formatSelectionForAgent,
  MAX_SELECTION_CHARS,
  selectionWhere
} from './agent-selection-format'

describe('formatSelectionForAgent', () => {
  it('quotes the selection with tab, host, and cwd', () => {
    const out = formatSelectionForAgent(
      { tabLabel: 'api', where: 'deploy@box', cwd: '/srv/app' },
      'TypeError: boom\n    at main.ts:12'
    )
    assert.equal(
      out,
      [
        'Operator selection from api (deploy@box, /srv/app)',
        '----',
        'TypeError: boom\n    at main.ts:12',
        '----'
      ].join('\n')
    )
  })

  it('does not add a fix instruction', () => {
    const out = formatSelectionForAgent({ tabLabel: 'Local 1', where: 'local' }, 'ls -la')
    assert.equal(out.includes('fix'), false)
    assert.equal(out.includes('explain'), false)
    assert.match(out, /unknown cwd/)
  })

  it('returns empty for blank selection', () => {
    assert.equal(formatSelectionForAgent({ tabLabel: 'x', where: 'local' }, '  \n'), '')
  })

  it('clips oversized selections', () => {
    const out = formatSelectionForAgent(
      { tabLabel: 'x', where: 'local', cwd: '/' },
      'a'.repeat(MAX_SELECTION_CHARS + 40)
    )
    assert.match(out, /truncated/)
    assert.ok(out.length < MAX_SELECTION_CHARS + 200)
  })
})

describe('formatPreviewCommentsForAgent', () => {
  it('lists comments and an optional screenshot path', async () => {
    const { formatPreviewCommentsForAgent } = await import('./agent-selection-format')
    const out = formatPreviewCommentsForAgent({
      tabLabel: 'Preview :5173',
      url: 'http://127.0.0.1:5173/',
      comments: [{ kind: 'pin', body: 'logo too big', x: 0.1, y: 0.2 }],
      screenshotPath: 'C:\\tmp\\shot.png'
    })
    assert.match(out, /Operator preview comments/)
    assert.match(out, /logo too big/)
    assert.match(out, /shot\.png/)
  })
})

describe('selectionWhere', () => {
  it('uses local for local sessions', () => {
    assert.equal(selectionWhere({ kind: 'local', title: 'Local 1' }), 'local')
  })

  it('prefers user@host from the tab title', () => {
    assert.equal(
      selectionWhere({
        kind: 'remote',
        title: 'ubuntu@lab',
        context: { kind: 'remote', os: 'linux', hostname: 'lab', detail: '' }
      }),
      'ubuntu@lab'
    )
  })
})
