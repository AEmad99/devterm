import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, it } from 'node:test'
import type { Client, ClientChannel } from 'ssh2'
import { detectRemoteContext } from './osDetect'

class FakeChannel extends EventEmitter {
  stderr = new EventEmitter()
  closed = false

  close(): void {
    this.closed = true
  }
}

describe('detectRemoteContext', () => {
  it('aborts context detection immediately when the transport closes', async () => {
    const client = {
      exec: () => undefined
    } as unknown as Client
    const abort = new AbortController()
    const detection = detectRemoteContext(client, 60_000, abort.signal)

    abort.abort()
    await assert.rejects(detection, /transport closed during startup/i)
  })

  it('closes exec channels whose callbacks arrive after timeout', async () => {
    const channels: FakeChannel[] = []
    const client = {
      exec: (
        _command: string,
        callback: (err: Error | undefined, channel: ClientChannel) => void
      ) => {
        const channel = new FakeChannel()
        channels.push(channel)
        setTimeout(() => callback(undefined, channel as unknown as ClientChannel), 20)
      }
    } as unknown as Client

    const context = await detectRemoteContext(client, 2)
    assert.equal(context.os, 'windows')
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(channels.length, 2)
    assert.ok(channels.every((channel) => channel.closed))
  })
})
