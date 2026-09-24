import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, it } from 'node:test'
import type { Client, ClientChannel } from 'ssh2'
import { detectRemoteContext, looksLikeWindowsBanner } from './osDetect'

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
    assert.equal(context.os, 'unknown')
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(channels.length, 2)
    assert.ok(channels.every((channel) => channel.closed))
  })

  it('does not treat a POSIX command-not-found as Windows', async () => {
    const client = {
      exec: (
        command: string,
        callback: (err: Error | undefined, channel: ClientChannel) => void
      ) => {
        const channel = new FakeChannel()
        queueMicrotask(() => {
          callback(undefined, channel as unknown as ClientChannel)
          if (command.startsWith('uname')) {
            channel.stderr.emit('data', Buffer.from('bash: uname: command not found\n'))
            channel.emit('close', 127)
          } else {
            channel.stderr.emit('data', Buffer.from('bash: cmd: command not found\n'))
            channel.emit('close', 127)
          }
        })
      }
    } as unknown as Client

    const context = await detectRemoteContext(client, 1000)
    assert.equal(context.os, 'unknown')
    assert.equal(looksLikeWindowsBanner('bash: powershell.exe: command not found'), false)
    assert.equal(
      looksLikeWindowsBanner('Microsoft Windows [Version 10.0.22631.3447]\nBASTION'),
      true
    )
  })

  it('detects a Windows banner from cmd ver', async () => {
    const client = {
      exec: (
        command: string,
        callback: (err: Error | undefined, channel: ClientChannel) => void
      ) => {
        const channel = new FakeChannel()
        queueMicrotask(() => {
          callback(undefined, channel as unknown as ClientChannel)
          if (command.startsWith('uname')) {
            channel.emit('close', 1)
          } else {
            channel.emit(
              'data',
              Buffer.from('Microsoft Windows [Version 10.0.22631.3447]\r\nBASTION\r\n')
            )
            channel.emit('close', 0)
          }
        })
      }
    } as unknown as Client

    const context = await detectRemoteContext(client, 1000)
    assert.equal(context.os, 'windows')
    assert.equal(context.hostname, 'BASTION')
  })
})
