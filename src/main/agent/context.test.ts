import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildAgentsMd, buildLocalNativeMd } from './context'
import type { HostContext } from '@shared/types'

const local: HostContext = {
  kind: 'local',
  os: 'windows',
  hostname: 'workstation',
  detail: 'Windows'
}

const remote: HostContext = {
  kind: 'remote',
  os: 'linux',
  hostname: 'fleet-01',
  detail: 'Ubuntu'
}

describe('agent briefings', () => {
  it('remote briefing steers through MCP host tools', () => {
    const md = buildAgentsMd(remote, false, '/home/op')
    assert.match(md, /mcp__devterm__run_command/)
    assert.match(md, /Built-in tools are disabled/)
    assert.match(md, /browser_list/)
  })

  it('local native briefing uses builtin tools and does not mention MCP host tools as required', () => {
    const md = buildLocalNativeMd(local, { cwd: 'D:\\projects\\app', browserTools: true })
    assert.match(md, /native coding agent/)
    assert.match(md, /built-in/i)
    assert.match(md, /not available/)
    assert.ok(md.includes('D:\\projects\\app'))
    assert.match(md, /mcp__devterm__browser_open/)
    assert.match(md, /first-class/i)
    assert.ok(md.indexOf('In-app browser') < md.indexOf('How to work'))
    assert.doesNotMatch(md, /Built-in tools are disabled/)
  })

  it('local native briefing omits browser tools when disabled', () => {
    const md = buildLocalNativeMd(local, { browserTools: false })
    assert.match(md, /browser tools are disabled/i)
    assert.doesNotMatch(md, /browser_open/)
  })
})
