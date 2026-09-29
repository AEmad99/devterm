import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createCertificatePromptBroker } from './certificate-prompt'
import type { BrowserCertificatePrompt } from '@shared/types'

function prompt(id = 'p1'): BrowserCertificatePrompt {
  return {
    id,
    host: 'app.test:8443',
    url: 'https://app.test:8443/',
    error: 'net::ERR_CERT_AUTHORITY_INVALID',
    subjectName: 'app.test',
    issuerName: 'Dev CA',
    fingerprint: 'AA:BB',
    validStart: 1_700_000_000,
    validExpiry: 1_800_000_000
  }
}

describe('certificate prompt broker', () => {
  it('resolves true only when the renderer trusts the certificate', async () => {
    const broker = createCertificatePromptBroker()
    const seen: string[] = []
    const decision = broker.ask(prompt(), (p) => {
      seen.push(p.id)
      return true
    })
    assert.deepEqual(seen, ['p1'])
    assert.equal(broker.pending().length, 1)
    broker.reply('p1', true)
    assert.equal(await decision, true)
    assert.equal(broker.pending().length, 0)
  })

  it('refuses when the prompt cannot be shown', async () => {
    const broker = createCertificatePromptBroker()
    const decision = await broker.ask(prompt(), () => false)
    assert.equal(decision, false)
    assert.equal(broker.pending().length, 0)
  })

  it('refuses when the operator does not answer', async () => {
    const broker = createCertificatePromptBroker(20)
    const decision = await broker.ask(prompt('slow'), () => true)
    assert.equal(decision, false)
  })

  it('ignores a second reply for the same prompt', async () => {
    const broker = createCertificatePromptBroker()
    const decision = broker.ask(prompt(), () => true)
    broker.reply('p1', false)
    broker.reply('p1', true)
    assert.equal(await decision, false)
  })
})
