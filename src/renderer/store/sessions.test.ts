import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import type { SSHStatus } from '@shared/types'
import { useSessions } from './sessions'

describe('SSH session status lifecycle', () => {
  afterEach(() => {
    useSessions.setState({ sessions: [], activeId: null, lastActiveId: null })
    Reflect.deleteProperty(globalThis, 'window')
  })

  it('keeps listening after a transient close and revives on reconnect', async () => {
    let onStatus: ((status: SSHStatus) => void) | undefined
    let disposed = false
    let disconnects = 0
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        devterm: {
          ssh: {
            connect: async () => ({
              sessionId: 'ssh-test',
              context: {
                kind: 'remote',
                os: 'linux',
                detail: 'Linux test',
                hostname: 'test-host'
              }
            }),
            onStatus: (_id: string, listener: (status: SSHStatus) => void) => {
              onStatus = listener
              return () => {
                disposed = true
              }
            },
            disconnect: () => {
              disconnects += 1
            }
          },
          agent: {
            close: () => undefined,
            closeWindow: () => undefined
          }
        }
      }
    })

    const id = await useSessions.getState().connectSsh({
      host: 'test-host',
      port: 22,
      username: 'tester'
    })
    assert.equal(id, 'ssh-test')
    assert.ok(onStatus)

    onStatus({ type: 'closed' })
    assert.equal(useSessions.getState().sessions[0]?.closed, true)
    assert.equal(disposed, false)

    onStatus({ type: 'reconnecting', attempt: 1, maxAttempts: 5, delayMs: 1000 })
    assert.match(useSessions.getState().sessions[0]?.status ?? '', /^reconnecting/)
    assert.equal(disposed, false)

    onStatus({ type: 'reconnected', attempt: 1 })
    assert.equal(useSessions.getState().sessions[0]?.closed, false)
    assert.equal(useSessions.getState().sessions[0]?.status, 'reconnected (attempt 1)')

    useSessions.getState().close('ssh-test')
    assert.equal(disposed, true)
    assert.equal(disconnects, 1)
  })
})
