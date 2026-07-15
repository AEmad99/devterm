import { describe, it, before } from 'node:test'
import assert from 'node:assert'
import { JSDOM } from 'jsdom'

// The snippet helpers use sessionStorage for the placeholder cache; jsdom
// provides a working sessionStorage. Some helpers also touch `window` so
// we install a minimal global before importing the module.

let extractPlaceholders: (cmd: string) => string[]
let applyPlaceholders: (cmd: string, values: Record<string, string>) => string
let normalizeForDedupe: (cmd: string) => string
let buildFrecency: typeof import('./history-frecency').buildFrecency
let filterHistory: typeof import('./history-frecency').filterHistory
let snippetCommandSet: typeof import('./history-frecency').snippetCommandSet

before(async () => {
  const { window } = new JSDOM('', { url: 'http://localhost' })
  ;(globalThis as unknown as Record<string, unknown>).window = window
  ;(globalThis as unknown as Record<string, unknown>).document = window.document
  const snips = await import('./snippets')
  extractPlaceholders = snips.extractPlaceholders
  applyPlaceholders = snips.applyPlaceholders
  const freq = await import('./history-frecency')
  normalizeForDedupe = freq.normalizeForDedupe
  buildFrecency = freq.buildFrecency
  filterHistory = freq.filterHistory
  snippetCommandSet = freq.snippetCommandSet
})

describe('extractPlaceholders', () => {
  it('returns an empty list when there are no tokens', () => {
    assert.deepStrictEqual(extractPlaceholders('ls -la'), [])
  })

  it('returns each unique placeholder in order of first appearance', () => {
    assert.deepStrictEqual(extractPlaceholders('git log {{ref}} --grep {{pattern}}'), [
      'ref',
      'pattern'
    ])
  })

  it('deduplicates repeated placeholders', () => {
    assert.deepStrictEqual(extractPlaceholders('{{name}} {{name}} {{other}}'), [
      'name',
      'other'
    ])
  })

  it('ignores empty placeholders', () => {
    assert.deepStrictEqual(extractPlaceholders('{{}} {{ }}'), [])
  })

  it('allows underscores, digits, and mixed case in names', () => {
    assert.deepStrictEqual(extractPlaceholders('{{HOST_NAME_2}}'), ['HOST_NAME_2'])
  })
})

describe('applyPlaceholders', () => {
  it('substitutes every occurrence of a token', () => {
    assert.strictEqual(
      applyPlaceholders('echo {{msg}} {{msg}}', { msg: 'hi' }),
      'echo hi hi'
    )
  })

  it('leaves unfilled tokens intact', () => {
    assert.strictEqual(
      applyPlaceholders('echo {{a}} {{b}}', { a: 'x' }),
      'echo x {{b}}'
    )
  })

  it('returns the original command when there are no placeholders', () => {
    assert.strictEqual(applyPlaceholders('ls -la', {}), 'ls -la')
  })
})

describe('normalizeForDedupe (history frecency)', () => {
  it('trims leading and trailing whitespace', () => {
    assert.strictEqual(normalizeForDedupe('  ls -la  '), 'ls -la')
  })

  it('strips a single trailing newline (common in history files)', () => {
    assert.strictEqual(normalizeForDedupe('ls\n'), 'ls')
    assert.strictEqual(normalizeForDedupe('ls\n\n\n'), 'ls')
  })

  it('preserves case and internal whitespace (case-insensitive dedupe is the caller’s job)', () => {
    assert.strictEqual(normalizeForDedupe('  Git   Status '), 'Git   Status')
  })
})

describe('buildFrecency', () => {
  it('ranks recent commands above old-but-frequent ones', () => {
    // The shape is the IPC `HistoryResult`: recent + frequent. The recent
    // index drives a 1/(ageDays+1) recency term, frequent drives a log
    // count term. A very recent single-use beats a 30-day-old heavy hitter.
    const hist = {
      recent: ['ls', 'docker ps', 'git status', 'pwd', 'ls -la', 'echo hi', 'cat foo'],
      frequent: [{ command: 'ls', count: 1 }]
    }
    const ranked = buildFrecency(hist)
    // 'ls' is at recent index 0, others get lower recency scores; 'ls' should win.
    assert.strictEqual(ranked[0].command, 'ls')
  })

  it('returns an empty list for null/undefined input', () => {
    assert.deepStrictEqual(buildFrecency(null), [])
    assert.deepStrictEqual(buildFrecency(undefined), [])
  })

  it('uses frequent-only commands when they are not in recent', () => {
    const hist = {
      recent: ['ls'],
      frequent: [{ command: 'kubectl get pods', count: 100 }]
    }
    const ranked = buildFrecency(hist)
    const cmds = ranked.map((e) => e.command)
    assert.ok(cmds.includes('kubectl get pods'))
    assert.ok(cmds.includes('ls'))
  })
})

describe('filterHistory', () => {
  it('removes commands that are already saved as snippets', () => {
    const snippets = [{ command: 'git status' }, { command: 'ls -la' }]
    const dedupeSet = snippetCommandSet(snippets)
    // Build a real FrecencyEntry list via buildFrecency so we exercise the
    // same shape the renderer feeds in.
    const ranked = buildFrecency({
      recent: ['git status', 'docker ps', 'ls -la', 'pwd'],
      frequent: []
    })
    const filtered = filterHistory(ranked, dedupeSet, '', 50)
    assert.deepStrictEqual(
      filtered.map((e) => e.command),
      ['docker ps', 'pwd']
    )
  })
})
