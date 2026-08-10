import { describe, it } from 'node:test'
import assert from 'node:assert'
import { parseProxyJump, parseSshConfig } from './ssh-config-parse'

describe('parseProxyJump', () => {
  it('parses user@host:port', () => {
    assert.deepStrictEqual(parseProxyJump('jump@bastion.example:2222'), {
      host: 'bastion.example',
      port: 2222,
      username: 'jump'
    })
  })

  it('defaults port to 22', () => {
    assert.deepStrictEqual(parseProxyJump('bastion'), {
      host: 'bastion',
      port: 22,
      username: undefined
    })
  })

  it('uses the first hop of a comma list', () => {
    const j = parseProxyJump('a@h1:22,b@h2:22')
    assert.strictEqual(j?.host, 'h1')
  })
})

describe('parseSshConfig', () => {
  it('imports a concrete Host with HostName/User/Port/IdentityFile', () => {
    const text = `
Host prod
  HostName 10.0.0.5
  User deploy
  Port 2222
  IdentityFile ~/.ssh/prod_ed25519
`
    const hosts = parseSshConfig(text)
    assert.strictEqual(hosts.length, 1)
    assert.deepStrictEqual(hosts[0], {
      alias: 'prod',
      host: '10.0.0.5',
      port: 2222,
      username: 'deploy',
      privateKeyPath: '~/.ssh/prod_ed25519',
      jump: undefined
    })
  })

  it('applies Host * defaults without importing the wildcard', () => {
    const text = `
Host *
  User ubuntu
  IdentityFile ~/.ssh/id_ed25519

Host web
  HostName web.internal
`
    const hosts = parseSshConfig(text)
    assert.strictEqual(hosts.length, 1)
    assert.strictEqual(hosts[0].alias, 'web')
    assert.strictEqual(hosts[0].username, 'ubuntu')
    assert.strictEqual(hosts[0].privateKeyPath, '~/.ssh/id_ed25519')
  })

  it('skips Host patterns that are only wildcards', () => {
    const text = `
Host *.example.com
  User root
Host *
  Port 22
`
    assert.strictEqual(parseSshConfig(text).length, 0)
  })

  it('parses ProxyJump', () => {
    const text = `
Host app
  HostName 10.1.2.3
  User app
  ProxyJump jump@bastion:22
`
    const hosts = parseSshConfig(text)
    assert.strictEqual(hosts[0].jump?.host, 'bastion')
    assert.strictEqual(hosts[0].jump?.username, 'jump')
  })

  it('uses Host alias as HostName when HostName is omitted', () => {
    const text = `Host github.com\n  User git\n`
    const hosts = parseSshConfig(text)
    assert.strictEqual(hosts[0].host, 'github.com')
    assert.strictEqual(hosts[0].username, 'git')
  })

  it('ignores comments and blank lines', () => {
    const text = `
# production
Host p1
  # HostName is below
  HostName p1.example # trailing
`
    const hosts = parseSshConfig(text)
    assert.strictEqual(hosts[0].host, 'p1.example')
  })
})
