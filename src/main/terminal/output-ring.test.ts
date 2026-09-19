import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { OutputRingBuffer, OutputRingStore } from './output-ring'

describe('OutputRingBuffer', () => {
  it('drops the oldest lines while retaining the newest output', () => {
    const ring = new OutputRingBuffer({ maxLines: 2, maxBytes: 1024 })

    ring.append('one\n')
    ring.append('two\n')
    ring.append('three\n')

    assert.equal(ring.replay(), 'two\nthree\n')
    assert.equal(ring.lineCount, 2)
  })

  it('concatenates arbitrary chunks and keeps an unterminated tail', () => {
    const ring = new OutputRingBuffer({ maxLines: 4, maxBytes: 1024 })

    ring.append('\x1b[32mhel')
    ring.append('lo\x1b[0m\nnext')
    ring.append(' line')

    assert.equal(ring.replay(), '\x1b[32mhello\x1b[0m\nnext line')
    assert.equal(ring.lineCount, 2)
    assert.equal(ring.byteLength, Buffer.byteLength(ring.replay(), 'utf8'))
  })

  it('bounds a long unterminated line by bytes', () => {
    const ring = new OutputRingBuffer({ maxLines: 10, maxBytes: 5 })

    ring.append('0123456789')

    assert.equal(ring.replay(), '56789')
    assert.ok(ring.byteLength <= 5)
  })
})

describe('OutputRingStore', () => {
  it('defaults to forwarding and can gate one stream without stopping its ring', () => {
    const store = new OutputRingStore({ maxLines: 2, maxBytes: 1024 })

    assert.equal(store.isForwarding('pty:one'), true)
    store.setForwarding('pty:one', false)
    store.append('pty:one', 'hidden\n')

    assert.equal(store.isForwarding('pty:one'), false)
    assert.equal(store.replay('pty:one'), 'hidden\n')
    store.setForwarding('pty:one', true)
    assert.equal(store.isForwarding('pty:one'), true)
  })

  it('replays a hibernated session and resumes its mapped stream', () => {
    const store = new OutputRingStore({ maxLines: 4, maxBytes: 1024 })

    store.bindSession('session-1', 'pty:one')
    store.append('pty:one', 'before\n')
    assert.equal(store.setForwardingForSession('session-1', false), true)
    store.append('pty:one', 'while hidden\n')

    assert.equal(store.replayAndResume('session-1'), 'before\nwhile hidden\n')
    assert.equal(store.isForwarding('pty:one'), true)
  })

  it('captures a mapped session without reopening a hibernation gate', () => {
    const store = new OutputRingStore({ maxLines: 4, maxBytes: 1024 })

    store.bindSession('session-1', 'ssh:one')
    store.setForwardingForSession('session-1', false)
    store.append('ssh:one', '\x1b[32mkept\x1b[0m\n')

    assert.equal(store.replayForSession('session-1'), '\x1b[32mkept\x1b[0m\n')
    assert.equal(store.isForwarding('ssh:one'), false)
  })
})
