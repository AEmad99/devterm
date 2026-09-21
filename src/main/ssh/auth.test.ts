import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { SSHHop } from '@shared/types'
import {
  AGENT_NO_KEY_ERROR,
  WINDOWS_SSH_AGENT_PIPE,
  authConfig,
  hopUsesAgent,
  mapAuthError,
  missingAgentPathError,
  systemAgentPath
} from './auth'

const hop = (patch: Partial<SSHHop> = {}): SSHHop => ({
  host: 'example.test',
  port: 22,
  username: 'op',
  ...patch
})

describe('hopUsesAgent', () => {
  it('defaults on when no key or password is set', () => {
    assert.equal(hopUsesAgent(hop()), true)
  })

  it('defaults off when a password or key path is present', () => {
    assert.equal(hopUsesAgent(hop({ password: 'x' })), false)
    assert.equal(hopUsesAgent(hop({ privateKeyPath: 'C:\\Users\\me\\.ssh\\id' })), false)
  })

  it('honors an explicit flag over the default', () => {
    assert.equal(hopUsesAgent(hop({ password: 'x', useAgent: true })), true)
    assert.equal(hopUsesAgent(hop({ useAgent: false })), false)
  })
})

describe('systemAgentPath', () => {
  it('uses the OpenSSH named pipe on Windows', () => {
    assert.equal(systemAgentPath({}, 'win32'), WINDOWS_SSH_AGENT_PIPE)
  })

  it('uses SSH_AUTH_SOCK on POSIX', () => {
    assert.equal(
      systemAgentPath({ SSH_AUTH_SOCK: '/tmp/ssh-agent.sock' }, 'linux'),
      '/tmp/ssh-agent.sock'
    )
    assert.equal(systemAgentPath({}, 'linux'), undefined)
  })
})

describe('authConfig', () => {
  it('sets the Windows agent pipe when agent auth is on', () => {
    if (process.platform !== 'win32') return
    const cfg = authConfig(hop({ useAgent: true }))
    assert.equal(cfg.agent, WINDOWS_SSH_AGENT_PIPE)
    assert.equal(cfg.password, undefined)
    assert.equal(cfg.privateKey, undefined)
  })

  it('keeps password auth when the operator chose a password', () => {
    const cfg = authConfig(hop({ password: 'secret', useAgent: false }))
    assert.equal(cfg.password, 'secret')
    assert.equal(cfg.agent, undefined)
  })
})

describe('mapAuthError', () => {
  it('names a missing usable key when agent-only auth fails', () => {
    const err = mapAuthError(new Error('All configured authentication methods failed'), hop())
    assert.equal(err.message, AGENT_NO_KEY_ERROR)
  })

  it('does not rewrite host-key or TCP failures', () => {
    const host = mapAuthError(new Error('Host key for example.test mismatch'), hop())
    assert.match(host.message, /Host key/)
    const tcp = mapAuthError(new Error('TCP connect to example.test:22 timed out'), hop())
    assert.match(tcp.message, /TCP connect/)
  })

  it('leaves password-only failures unchanged', () => {
    const err = mapAuthError(
      new Error('All configured authentication methods failed'),
      hop({ password: 'x', useAgent: false })
    )
    assert.match(err.message, /All configured/)
  })
})

describe('missingAgentPathError', () => {
  it('is silent when a path exists', () => {
    if (process.platform !== 'win32') return
    assert.equal(missingAgentPathError(hop()), null)
  })
})
