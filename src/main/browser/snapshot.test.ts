import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  buildSnapshotScript,
  formatOutline,
  parseSnapshot,
  type OutlineNode
} from './snapshot'

describe('snapshot buildSnapshotScript', () => {
  it('is a self-evaluating script with the interactive selector and ref hygiene', () => {
    const s = buildSnapshotScript()
    assert.ok(s.startsWith('(function(){'))
    assert.ok(s.includes('data-dt-ref'))
    assert.ok(s.includes("removeAttribute('data-dt-ref')"))
    assert.ok(s.includes('a[href]'))
    assert.ok(s.includes('JSON.stringify({title:document.title'))
    // Node cap is embedded as a literal.
    assert.ok(s.includes('var MAX=400'))
  })
  it('clamps the node cap into a sane range', () => {
    assert.ok(buildSnapshotScript({ maxNodes: 1 }).includes('var MAX=50'))
    assert.ok(buildSnapshotScript({ maxNodes: 99999 }).includes('var MAX=1000'))
  })
})

describe('snapshot parseSnapshot', () => {
  it('parses the stringified guest payload', () => {
    const raw = JSON.stringify({
      title: 'Prod',
      url: 'https://x.test/',
      root: { r: 'page', title: 'Prod', url: 'https://x.test/', kids: [] }
    })
    const p = parseSnapshot(raw)
    assert.equal(p.title, 'Prod')
    assert.equal(p.url, 'https://x.test/')
    assert.ok(p.root)
  })
  it('rejects malformed payloads loudly', () => {
    assert.throws(() => parseSnapshot('{"nope":true}'))
  })
})

function page(kids: OutlineNode[]): { r: string; title: string; url: string; kids: OutlineNode[] } {
  return { r: 'page', title: 'T', url: 'https://t.test/', kids }
}

describe('snapshot formatOutline', () => {
  it('renders roles, names, refs, hrefs, values, and nesting', () => {
    const out = formatOutline({
      title: 'Sign in',
      url: 'https://app.test/login',
      root: page([
        { r: 'heading', n: 'Welcome', lvl: 1 },
        {
          r: 'group',
          kids: [
            { r: 'textbox', n: 'Email', v: 'a@b.c', ref: 'e4' },
            { r: 'textbox', n: 'Password', ref: 'e5' },
            { r: 'button', n: 'Sign in', ref: 'e6' }
          ]
        },
        { r: 'link', n: 'Docs', href: '/docs', ref: 'e9' }
      ])
    })
    const lines = out.split('\n')
    assert.equal(lines[0], 'PAGE Sign in · https://app.test/login')
    assert.ok(out.includes('[h1] "Welcome"'))
    assert.ok(out.includes('textbox "Email" value="a@b.c" [e4]'))
    assert.ok(out.includes('button "Sign in" [e6]'))
    assert.ok(out.includes('link "Docs" → /docs [e9]'))
    // Nested group indents its children one level deeper than the heading
    // (top-level nodes carry no indentation).
    const emailIdx = lines.findIndex((l) => l.includes('[e4]'))
    const headIdx = lines.findIndex((l) => l.includes('[h1]'))
    assert.ok(emailIdx > headIdx)
    assert.ok(!lines[headIdx].startsWith(' '))
    assert.ok(lines[emailIdx].startsWith('  textbox'))
  })
  it('marks checkbox state', () => {
    const out = formatOutline({
      title: '',
      url: 'x',
      root: page([
        { r: 'checkbox', n: 'Remember', chk: true, ref: 'e2' },
        { r: 'radio', n: 'Other', chk: false, ref: 'e3' }
      ])
    })
    assert.ok(out.includes('[checked]'))
    assert.ok(out.includes('[unchecked]'))
  })
  it('hard-caps output and marks the truncation', () => {
    const big = formatOutline(
      {
        title: 'big',
        url: 'x',
        root: page(Array.from({ length: 400 }, (_, i) => ({ r: 'text', n: `row ${i}` })))
      },
      800
    )
    // Content is capped at maxChars; the truncation marker rides on top.
    assert.ok(big.length <= 830)
    assert.ok(big.endsWith('…[outline truncated]'))
  })
})
