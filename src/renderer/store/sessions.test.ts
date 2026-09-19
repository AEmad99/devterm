import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import type { SSHStatus } from '@shared/types'
import { useSessions } from './sessions'
import { DEFAULT_GROUP, useLayout } from './layout'

describe('SSH session status lifecycle', () => {
  afterEach(() => {
    useSessions.setState({ sessions: [], activeId: null, lastActiveId: null })
    useLayout.setState({
      groups: [{ id: DEFAULT_GROUP, name: 'Terminals', root: null, activeLeaf: null }],
      activeGroupId: DEFAULT_GROUP,
      focusedId: null,
      groupFlags: {}
    })
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

  it('paints a deferred remote tab before opening SSH', async () => {
    let connects = 0
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        devterm: {
          ssh: {
            connect: async () => {
              connects++
              return {
                sessionId: 'ssh-deferred',
                context: {
                  kind: 'remote',
                  os: 'linux',
                  detail: 'Linux test',
                  hostname: 'deferred-host'
                }
              }
            },
            onStatus: () => () => undefined,
            disconnect: () => undefined
          },
          agent: { close: () => undefined, closeWindow: () => undefined }
        }
      }
    })

    const pending = useSessions.getState().addDeferredRemote({
      profile: { host: 'deferred-host', port: 22, username: 'tester' },
      connectionId: 'saved-1',
      groupId: DEFAULT_GROUP,
      title: 'Deferred host'
    })
    useLayout.getState().sync([{ id: pending, groupId: DEFAULT_GROUP }])
    assert.equal(connects, 0)
    assert.equal(useSessions.getState().sessions[0]?.deferredRemote, true)

    const live = await useSessions.getState().connectDeferred(pending)
    assert.equal(live, 'ssh-deferred')
    assert.equal(connects, 1)
    assert.equal(useSessions.getState().sessions[0]?.id, 'ssh-deferred')
    assert.equal(useSessions.getState().sessions[0]?.deferredRemote, undefined)
    const root = useLayout.getState().groups[0].root
    assert.equal(root?.type, 'leaf')
    assert.deepEqual(root?.type === 'leaf' ? root.tabs : [], ['ssh-deferred'])
  })
})
