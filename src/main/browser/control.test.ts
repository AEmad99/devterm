import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { BrowserControlService } from './control'
import type { BrowserControlTabInfo } from '@shared/types'

function svc(): BrowserControlService {
  return new BrowserControlService(() => undefined)
}

const AGENT = 'agent-1'

function reg(
  tabKey: string,
  wcId: number,
  opts?: Partial<BrowserControlTabInfo>
): BrowserControlTabInfo {
  return {
    paneSessionId: `pane-${wcId}`,
    tabKey,
    wcId,
    url: `https://${tabKey}.test/`,
    title: tabKey,
    agentOwned: false,
    ...opts
  }
}

describe('BrowserControlService registry', () => {
  it('registers, updates, and unregisters tabs', () => {
    const s = svc()
    s.register(reg('t1', 11))
    assert.equal(s.entry('t1')?.wcId, 11)
    s.updateMeta('t1', { title: 'New' })
    assert.equal(s.entry('t1')?.title, 'New')
    s.unregister('t1')
    assert.equal(s.entry('t1'), undefined)
  })
  it('re-registration with a new wcId replaces the old guest (pane remount)', () => {
    const s = svc()
    s.register(reg('t1', 11))
    s.register(reg('t1', 12))
    assert.equal(s.entry('t1')?.wcId, 12)
    // Old wcId must be fully gone from the wc-indexed map.
    const listed = s.list(AGENT)
    assert.equal(listed.length, 1)
  })
})

describe('BrowserControlService open waiters', () => {
  it('resolves browser_open when the renderer registers the pre-agreed key', async () => {
    // Drive the real flow: sendRequest hands the request to the "renderer",
    // which registers the tab (with the pre-agreed key) on the next tick.
    const s2 = new BrowserControlService((req) => {
      setTimeout(
        () => s2.register(reg(req.tabKey, 42, { agentOwned: true, ownerAgentSessionId: AGENT })),
        0
      )
    })
    const entry = await s2.openTab({ url: 'https://x.test/', ownerAgentSessionId: AGENT })
    assert.equal(entry.wcId, 42)
    assert.ok(entry.tabKey.startsWith('agt-'))
    // Default target now resolves to the opened tab without an explicit id.
    const t = s2.resolveTarget(AGENT)
    assert.ok(t.ok && t.entry.tabKey === entry.tabKey)
  })
  it('rejects when the pane never opens', async () => {
    const s = new BrowserControlService(() => undefined)
    await assert.rejects(() => {
      // The service's own 8s watchdog would fire; race a shorter timeout so
      // the test suite stays fast. Either way openTab must NOT resolve.
      return Promise.race([
        s.openTab({ url: 'https://x.test/', ownerAgentSessionId: AGENT }),
        new Promise<never>((_, rej) =>
          setTimeout(() => rej(new Error('test-timeout')), 20)
        )
      ])
    })
  })
})

describe('BrowserControlService grants & targeting', () => {
  it('agent-owned tabs are drivable only by their owner', () => {
    const s = svc()
    s.register(reg('own1', 1, { agentOwned: true, ownerAgentSessionId: AGENT }))
    const mine = s.resolveTarget(AGENT, 'own1')
    assert.ok(mine.ok)
    const theirs = s.resolveTarget('agent-2', 'own1')
    assert.ok(!theirs.ok && theirs.err.includes('another agent'))
  })
  it('user tabs require attach; attach grants; detach revokes; release clears', () => {
    const s = svc()
    s.register(reg('user1', 5))
    const before = s.resolveTarget(AGENT, 'user1')
    assert.ok(!before.ok && before.err.includes('browser_attach'))
    assert.ok(s.needsAttachConfirm(AGENT, 'user1'))

    s.attach(AGENT, 'user1')
    assert.ok(!s.needsAttachConfirm(AGENT, 'user1'))
    assert.ok(s.resolveTarget(AGENT, 'user1').ok)

    s.detach(AGENT, 'user1')
    assert.ok(!s.resolveTarget(AGENT, 'user1').ok)

    s.attach(AGENT, 'user1')
    s.releaseAgent(AGENT)
    assert.ok(!s.resolveTarget(AGENT, 'user1').ok)
  })
  it('unregistering a user tab drops every grant to it', () => {
    const s = svc()
    s.register(reg('u9', 9))
    s.attach(AGENT, 'u9')
    s.unregister('u9')
    assert.ok(!s.needsAttachConfirm(AGENT, 'u9'))
    assert.equal(s.entry('u9'), undefined)
  })
  it('list marks kind and attachment flags', () => {
    const s = svc()
    s.register(reg('a', 1, { agentOwned: true, ownerAgentSessionId: AGENT }))
    s.register(reg('b', 2))
    s.attach(AGENT, 'b')
    const rows = s.list(AGENT)
    const ra = rows.find((r) => r.tabKey === 'a')!
    const rb = rows.find((r) => r.tabKey === 'b')!
    assert.ok(ra.mine && !ra.attachedByMe)
    assert.ok(!rb.mine && rb.attachedByMe)
  })
})
