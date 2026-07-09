import { describe, it, before } from 'node:test'
import assert from 'node:assert'
import { JSDOM } from 'jsdom'

let renderMarkdownToSafeHtml: (source: string) => string

before(async () => {
  const { window } = new JSDOM('')
  ;(globalThis as unknown as Record<string, unknown>).window = window
  ;(globalThis as unknown as Record<string, unknown>).document = window.document
  const mod = await import('./markdown-preview')
  renderMarkdownToSafeHtml = mod.renderMarkdownToSafeHtml
})

describe('renderMarkdownToSafeHtml', () => {
  it('renders headings with deterministic ids', () => {
    const html = renderMarkdownToSafeHtml('# Hello World!')
    assert(html.includes('<h1 id="hello-world">Hello World!</h1>'))
  })

  it('renders emphasis and strikethrough', () => {
    const html = renderMarkdownToSafeHtml('**bold** *em* ~~strike~~')
    assert(html.includes('<strong>bold</strong>'))
    assert(html.includes('<em>em</em>'))
    assert(html.includes('<del>strike</del>'))
  })

  it('renders GFM tables', () => {
    const html = renderMarkdownToSafeHtml('| a | b |\n|---|---|\n| 1 | 2 |')
    assert(html.includes('<table>'))
    assert(html.includes('<thead>'))
    assert(html.includes('<tbody>'))
    assert(html.includes('<th'))
    assert(html.includes('<td'))
  })

  it('renders fenced code with language class', () => {
    const html = renderMarkdownToSafeHtml('```js\nconst x = 1;\n```')
    assert(html.includes('<pre>'))
    assert(html.includes('<code class="language-js">'))
  })

  it('renders task-list checkboxes as disabled', () => {
    const html = renderMarkdownToSafeHtml('- [ ] todo\n- [x] done')
    assert(html.includes('<input'))
    assert(html.includes('type="checkbox"'))
    assert(html.includes('disabled=""') || html.includes('disabled'))
    assert(html.includes('checked=""') || html.includes('checked'))
    assert(!html.includes('enabled'))
  })

  it('removes script tags and inline event handlers', () => {
    const html = renderMarkdownToSafeHtml('<script>alert(1)</script>\n<img src=x onerror=alert(1)>')
    assert(!html.includes('<script>'))
    assert(!html.includes('onerror'))
    assert(!html.includes('alert(1)'))
  })

  it('neutralizes javascript: links', () => {
    const html = renderMarkdownToSafeHtml('[x](javascript:alert(1))')
    assert(!html.includes('javascript:'))
    assert(!html.includes('alert(1)'))
  })

  it('allows data: image sources and blocks remote/relative images', () => {
    const dataUrl = 'data:image/png;base64,iVBORw0KGgo='
    const html = renderMarkdownToSafeHtml(
      `![ok](${dataUrl})\n![remote](https://example.com/x.png)\n![rel](./x.png)`
    )
    assert(html.includes(`src="${dataUrl}"`))
    assert(!html.includes('https://example.com'))
    assert(!html.includes('./x.png'))
  })

  it('preserves safe external links', () => {
    const html = renderMarkdownToSafeHtml('[link](https://example.com)')
    assert(html.includes('href="https://example.com"'))
    assert(html.includes('<a'))
  })

  it('preserves hash links', () => {
    const html = renderMarkdownToSafeHtml('[section](#section-one)')
    assert(html.includes('href="#section-one"'))
  })

  it('removes unexpected tags', () => {
    const html = renderMarkdownToSafeHtml('<iframe src="evil"></iframe>')
    assert(!html.includes('<iframe'))
  })
})
