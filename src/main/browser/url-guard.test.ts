import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { externalUrlOk, guestUrlOk, toLoadableUrl } from './url-guard'

describe('url-guard guestUrlOk', () => {
  it('allows http(s) and about:blank', () => {
    assert.equal(guestUrlOk('http://localhost:3000'), true)
    assert.equal(guestUrlOk('https://grafana.corp/d/shx'), true)
    assert.equal(guestUrlOk('HTTPS://EXAMPLE.COM'), true)
    assert.equal(guestUrlOk('about:blank'), true)
  })
  it('rejects everything that could escape the web sandbox', () => {
    for (const bad of [
      'file:///etc/passwd',
      'file://C:/Windows/win.ini',
      'chrome://settings',
      'devtools://devtools/bundled/inspector.html',
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox',
      'about:config',
      '',
      '   '
    ]) {
      assert.equal(guestUrlOk(bad), false, `should reject: ${bad}`)
    }
  })
})

describe('url-guard toLoadableUrl', () => {
  it('prefixes bare hosts with http', () => {
    assert.equal(toLoadableUrl('localhost:3000'), 'http://localhost:3000')
    assert.equal(toLoadableUrl(' 10.0.0.5:8080/app '), 'http://10.0.0.5:8080/app')
  })
  it('keeps explicit schemes untouched for the guard to judge', () => {
    assert.equal(toLoadableUrl('https://x.com'), 'https://x.com')
    assert.equal(toLoadableUrl('file:///etc/passwd'), 'file:///etc/passwd')
  })
  it('normalizes about:blank and rejects empty input', () => {
    assert.equal(toLoadableUrl('about:blank'), 'about:blank')
    assert.equal(toLoadableUrl(''), null)
    assert.equal(toLoadableUrl('   '), null)
  })
})

describe('url-guard externalUrlOk', () => {
  it('mirrors the OS-browser allowlist', () => {
    assert.equal(externalUrlOk('https://x.com'), true)
    assert.equal(externalUrlOk('mailto:a@b.c'), true)
    assert.equal(externalUrlOk('file:///etc/passwd'), false)
    assert.equal(externalUrlOk('not a url'), false)
  })
})
