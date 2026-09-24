import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createExecGate } from './exec-gate'

describe('createExecGate', () => {
  it('runs up to the slot limit and queues the rest', async () => {
    const gate = createExecGate(2)
    const order: string[] = []
    const releaseA = await gate.acquire()
    const releaseB = await gate.acquire()
    let cStarted = false
    const pending = gate.acquire().then((release) => {
      cStarted = true
      order.push('c')
      release()
    })
    await Promise.resolve()
    assert.equal(cStarted, false)
    order.push('a')
    releaseA()
    await pending
    assert.deepEqual(order, ['a', 'c'])
    releaseB()
  })
})
