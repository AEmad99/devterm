import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Client } from 'ssh2'
import type { HostContext, SSHProfile, SSHStatus } from '@shared/types'
import { SSHManager } from './manager'

interface TestSession {
  id: string
  client?: Client
  context: HostContext
  profile: SSHProfile
  closing?: boolean
  exitReported?: boolean
}

interface ManagerInternals {
  sessions: Map<string, TestSession>
  handleTransportClose(sessionId: string, client: Client): void
  reportExit(session: TestSession): void
}

describe('SSHManager close identity', () => {
  it('ignores stale client closes and reports the current transport once', () => {
    const statuses: SSHStatus[] = []
    let exits = 0
    const manager = new SSHManager({
      onData: () => undefined,
      onExit: () => {
        exits += 1
      },
      onStatus: (_id, status) => statuses.push(status)
    })
    manager.setReconnectPolicy({ enabled: false })

    const staleClient = {} as Client
    const currentClient = {} as Client
    const session: TestSession = {
      id: 'ssh-test',
      client: currentClient,
      context: {
        kind: 'remote',
        os: 'linux',
        detail: 'Linux test',
        hostname: 'test-host'
      },
      profile: {
        host: 'test-host',
        port: 22,
        username: 'tester'
      }
    }
    const internals = manager as unknown as ManagerInternals
    internals.sessions.set(session.id, session)

    internals.handleTransportClose(session.id, staleClient)
    assert.equal(exits, 0)
    assert.deepEqual(statuses, [])
    assert.equal(session.client, currentClient)

    // Whichever close path arrives first owns the one renderer exit event.
    internals.reportExit(session)
    internals.handleTransportClose(session.id, currentClient)
    assert.equal(exits, 1)
    assert.deepEqual(statuses, [{ type: 'closed' }])
    assert.equal(session.client, undefined)
  })
})
