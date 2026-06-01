import { generateKeyPairSync, randomBytes } from 'crypto'
import { promises as fsp, writeSync } from 'fs'
import os from 'os'
import { join } from 'path'
import { Server } from 'ssh2'
import type { AddressInfo } from 'net'
import { PtyManager, defaultShell } from './pty/manager'
import { SSHManager } from './ssh/manager'
import { listRemote, mkdirRemote, renameRemote, deleteRemote } from './ssh/sftp'
import { TransferManager } from './transfer'
import { startSftpServer } from './selftest-sftp'
import { McpBridge } from './mcp/server'
import { Policy } from './mcp/policy'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { SSHStatus, TransferProgress } from '@shared/types'

const results: { name: string; ok: boolean; info: string }[] = []
// Write synchronously to fd 1 so progress is visible even if a later step hangs
// (Node block-buffers piped stdout, hiding progress until process exit).
function logLine(s: string) {
  try {
    writeSync(1, s + '\n')
  } catch {
    console.log(s)
  }
}
function check(name: string, ok: boolean, info = '') {
  results.push({ name, ok, info })
  logLine(`${ok ? 'OK  ' : 'FAIL'} ${name}${info ? ' — ' + info : ''}`)
}

/** Resolve `p`, but never block longer than `ms` (for teardown that may hang). */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | void> {
  return Promise.race([p.catch(() => {}), new Promise<void>((r) => setTimeout(r, ms))])
}

// --- Local PTY: verify common shell commands work (the ls/cd bug) -----------
function testLocalShell(): Promise<void> {
  return new Promise((resolve) => {
    let buf = ''
    const mgr = new PtyManager({
      onData: (_id, d) => (buf += d),
      onExit: () => {}
    })
    const { id, shell } = mgr.create({ cols: 120, rows: 30 })
    const isPwsh = /powershell|pwsh/i.test(shell)
    check('local shell is PowerShell (not cmd.exe)', isPwsh || process.platform !== 'win32', shell)
    // Exercise cd, ls and echo; marker proves the line was processed.
    const cmd =
      process.platform === 'win32'
        ? 'cd $HOME; ls | Out-Null; pwd | Out-Null; Write-Output DEVTERM_CMD_OK\r'
        : 'cd $HOME && ls >/dev/null && pwd >/dev/null && echo DEVTERM_CMD_OK\n'
    setTimeout(() => mgr.input(id, cmd), 1200)

    setTimeout(() => {
      const notRecognized = /not recognized|CommandNotFoundException|command not found/i.test(buf)
      check('cd/ls/pwd/echo run in local shell', buf.includes('DEVTERM_CMD_OK') && !notRecognized)
      // OSC 7 working-directory reporting (powers the file explorer sidebar).
      const osc7 = /\x1b\]7;file:\/\/[^\x07\x1b]*/.exec(buf)
      check(
        'shell emits OSC 7 cwd (explorer can follow cd)',
        process.platform !== 'win32' || (!!osc7 && /file:\/\/\/[A-Za-z]:/.test(osc7[0])),
        osc7 ? osc7[0].replace('\x1b]7;', '') : 'none'
      )
      mgr.killAll()
      resolve()
    }, 4500)
  })
}

// --- SSH mock server --------------------------------------------------------
type Scenario = 'linux' | 'windows'

function startMockServer(scenario: Scenario): Promise<{ port: number; close: () => void }> {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' }
  })

  const server = new Server({ hostKeys: [privateKey] }, (client) => {
    client.on('authentication', (ctx) => ctx.accept())
    client.on('ready', () => {
      client.on('session', (acceptSession) => {
        const session = acceptSession()
        session.on('pty', (accept) => accept && accept())
        session.on('shell', (accept) => {
          const stream = accept()
          stream.write('mock-shell-ready\r\n')
          // Echo input back, like a real shell would render typed chars.
          stream.on('data', (d: Buffer) => stream.write(d))
        })
        session.on('exec', (accept, _reject, info) => {
          const stream = accept()
          const cmd = info.command
          if (scenario === 'linux') {
            if (cmd.startsWith('uname')) stream.write('Linux mockhost 5.15.0 x86_64 GNU/Linux\n')
            else if (cmd.startsWith('hostname')) stream.write('mockhost\n')
            stream.exit(0)
          } else {
            // Windows remote: uname fails; cmd-style probe succeeds.
            if (cmd.startsWith('uname')) {
              stream.stderr.write("'uname' is not recognized\n")
              stream.exit(127)
            } else {
              stream.write('Microsoft Windows [Version 10.0.22631]\r\nWINBOX\r\n')
              stream.exit(0)
            }
          }
          stream.end()
        })
      })
    })
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port
      resolve({ port, close: () => server.close() })
    })
  })
}

async function testSshScenario(scenario: Scenario): Promise<void> {
  const srv = await startMockServer(scenario)
  let shellData = ''
  const statuses: SSHStatus[] = []
  const mgr = new SSHManager({
    onData: (_id, d) => (shellData += d),
    onExit: () => {},
    onStatus: (_id, s) => statuses.push(s)
  })

  try {
    const { sessionId, context } = await mgr.connect({
      host: '127.0.0.1',
      port: srv.port,
      username: 'tester',
      password: 'x'
    })
    check(`ssh connect (${scenario})`, true, `ctx.os=${context.os}`)
    check(`host-key recorded on first use (${scenario})`, statuses.some((s) => s.type === 'hostkey-new'))
    check(`OS detected as ${scenario}`, context.os === scenario, context.detail.split(/\r?\n/)[0])

    await mgr.openShell(sessionId, 80, 24)
    await new Promise((r) => setTimeout(r, 300))
    mgr.input(sessionId, 'whoami\n')
    await new Promise((r) => setTimeout(r, 400))
    check(`remote shell channel echoes (${scenario})`, shellData.includes('mock-shell-ready'))
    mgr.disconnect(sessionId)
  } catch (e) {
    check(`ssh scenario ${scenario}`, false, String((e as Error).message || e))
  } finally {
    srv.close()
  }
}

// --- SFTP browse + transfer round-trip against an fs-backed server ----------
async function testSftp(): Promise<void> {
  const root = await fsp.mkdtemp(join(os.tmpdir(), 'devterm-sftp-'))
  const dlDir = await fsp.mkdtemp(join(os.tmpdir(), 'devterm-dl-'))
  // Seed a remote tree and a local file to upload.
  await fsp.writeFile(join(root, 'hello.txt'), 'hi from remote')
  await fsp.mkdir(join(root, 'sub'))
  const localUpload = join(dlDir, 'upload.bin')
  const payload = randomBytes(256 * 1024) // 256 KB to exercise chunked streaming
  await fsp.writeFile(localUpload, payload)

  const srv = await startSftpServer(root)
  const mgr = new SSHManager({ onData: () => {}, onExit: () => {}, onStatus: () => {} })
  try {
    const { sessionId } = await mgr.connect({
      host: '127.0.0.1',
      port: srv.port,
      username: 'tester',
      password: 'x'
    })
    const sftp = await mgr.getSftp(sessionId)

    const listing = await listRemote(sftp, root)
    check(
      'sftp list shows seeded entries',
      listing.entries.some((e) => e.name === 'hello.txt') &&
        listing.entries.some((e) => e.name === 'sub' && e.isDir)
    )

    await mkdirRemote(sftp, join(root, 'made').replace(/\\/g, '/'))
    check('sftp mkdir', await exists(join(root, 'made')))

    await renameRemote(sftp, join(root, 'made').replace(/\\/g, '/'), join(root, 'renamed').replace(/\\/g, '/'))
    check('sftp rename', (await exists(join(root, 'renamed'))) && !(await exists(join(root, 'made'))))

    await deleteRemote(sftp, join(root, 'renamed').replace(/\\/g, '/'))
    check('sftp delete', !(await exists(join(root, 'renamed'))))

    // Transfer round-trip: upload local -> remote, then download it back.
    const tm = new TransferManager({
      getSftp: (sid) => mgr.getSftp(sid),
      onProgress: () => {}
    })
    const remoteUpload = (root + '/uploaded.bin').replace(/\\/g, '/')
    await runTransfer(tm, { direction: 'upload', sessionId, localPath: localUpload, remotePath: remoteUpload })
    const uploaded = await fsp.readFile(join(root, 'uploaded.bin'))
    check('sftp upload integrity (256 KB)', uploaded.equals(payload))

    const localBack = join(dlDir, 'roundtrip.bin')
    await runTransfer(tm, { direction: 'download', sessionId, localPath: localBack, remotePath: remoteUpload })
    const back = await fsp.readFile(localBack)
    check('sftp download round-trip integrity', back.equals(payload))

    // Cancel: put a large file remote-side, then abort its download mid-flight.
    const bigLocal = join(dlDir, 'big.bin')
    const bigRemote = (root + '/big.bin').replace(/\\/g, '/')
    await fsp.writeFile(bigLocal, randomBytes(8 * 1024 * 1024))
    await runTransfer(tm, { direction: 'upload', sessionId, localPath: bigLocal, remotePath: bigRemote })
    const cancelResult = await new Promise<TransferProgress>((resolve) => {
      const tmC = new TransferManager({
        getSftp: (sid) => mgr.getSftp(sid),
        onProgress: (i, p) => {
          if (!p.done && p.transferred > 0) tmC.cancel(i)
          if (p.done) resolve(p)
        }
      })
      tmC.start({ direction: 'download', sessionId, localPath: join(dlDir, 'big-dl.bin'), remotePath: bigRemote })
    })
    check('transfer cancel truly aborts', cancelResult.canceled === true && cancelResult.transferred < 8 * 1024 * 1024)

    mgr.disconnect(sessionId)
  } catch (e) {
    check('sftp scenario', false, String((e as Error).message || e))
  } finally {
    srv.close()
    await fsp.rm(root, { recursive: true, force: true })
    await fsp.rm(dlDir, { recursive: true, force: true })
  }
}

function exists(p: string): Promise<boolean> {
  return fsp
    .access(p)
    .then(() => true)
    .catch(() => false)
}

function runTransfer(
  tm: TransferManager,
  opts: Parameters<TransferManager['start']>[0]
): Promise<TransferProgress> {
  return new Promise((resolve, reject) => {
    // Bridge the manager's progress callback for just this id.
    const id = tm.start(opts)
    // The TransferManager reports via its onProgress dep, which we set to noop;
    // poll completion by re-reading is avoided — instead we wrap start below.
    void id
    // Fallback timeout guard.
    const timer = setTimeout(() => reject(new Error('transfer timeout')), 15000)
    const orig = (tm as unknown as { deps: { onProgress: (i: string, p: TransferProgress) => void } }).deps
    const prev = orig.onProgress
    orig.onProgress = (i, p) => {
      prev(i, p)
      if (i === id && p.done) {
        clearTimeout(timer)
        orig.onProgress = prev
        p.error ? reject(new Error(p.error)) : resolve(p)
      }
    }
  })
}

// --- Guardrail policy (unit) ------------------------------------------------
function testPolicy(): void {
  const ro = new Policy('read_only')
  check('policy: read-only blocks rm -rf', ro.evaluateCommand('rm -rf /tmp/x').allow === false)
  check('policy: read-only allows ls', ro.evaluateCommand('ls -la /etc').allow === true)
  check('policy: read-only blocks write_file', ro.evaluateWrite().allow === false)
  const cf = new Policy('confirm')
  check('policy: confirm gates run_command', cf.evaluateCommand('ls').needConfirm === true)
  const full = new Policy('full')
  check('policy: full forces confirm on destructive', full.evaluateCommand('mkfs /dev/sda').needConfirm === true)
}

// --- MCP bridge end-to-end via a real MCP client (5b acceptance) ------------
function textOf(res: unknown): string {
  const content = (res as { content?: Array<{ text?: string }> }).content ?? []
  return content.map((c) => c.text ?? '').join('')
}

async function testBridge(): Promise<void> {
  const root = await fsp.mkdtemp(join(os.tmpdir(), 'devterm-bridge-'))
  await fsp.writeFile(join(root, 'hello.txt'), 'hi from remote')
  const srv = await startSftpServer(root)
  const mgr = new SSHManager({ onData: () => {}, onExit: () => {}, onStatus: () => {} })
  let bridge: McpBridge | undefined
  let client: Client | undefined
  try {
    const { sessionId } = await mgr.connect({ host: '127.0.0.1', port: srv.port, username: 'tester', password: 'x' })
    const context = mgr.getContext(sessionId)!

    bridge = new McpBridge({
      sessionId,
      ssh: mgr,
      context,
      airGapped: true,
      policy: new Policy('full'),
      confirm: async () => 'approved' as const
    })
    const info = await bridge.start()
    check('mcp bridge binds to 127.0.0.1 with token', info.url.startsWith('http://127.0.0.1:') && info.token.length > 0)

    // Wrong token must be rejected.
    const badResp = await fetch(info.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: 'Bearer wrong' },
      body: '{}'
    }).then((r) => r.status)
    check('mcp bridge rejects bad bearer token', badResp === 401)

    client = new Client({ name: 'devterm-selftest', version: '0.1.0' })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(info.url), {
        requestInit: { headers: { Authorization: `Bearer ${info.token}` } }
      })
    )

    const tools = await client.listTools()
    const names = tools.tools.map((t) => t.name).sort()
    check('mcp lists host tools', ['get_host_context', 'list_dir', 'read_file', 'run_command', 'write_file'].every((n) => names.includes(n)), names.join(','))

    const hostname = textOf(await client.callTool({ name: 'run_command', arguments: { command: 'hostname' } }))
    check('mcp run_command("hostname") hits remote over same connection', hostname.includes('sftphost'), hostname.trim())

    const ctxText = textOf(await client.callTool({ name: 'get_host_context', arguments: {} }))
    check('mcp get_host_context reports air-gapped', ctxText.includes('"airGapped": true') && ctxText.includes('sftphost'))

    const ls = textOf(await client.callTool({ name: 'list_dir', arguments: { path: root } }))
    check('mcp list_dir lists remote files', ls.includes('hello.txt'))

    const fileTxt = textOf(await client.callTool({ name: 'read_file', arguments: { path: (root + '/hello.txt').replace(/\\/g, '/') } }))
    check('mcp read_file returns content', fileTxt.includes('hi from remote'))

    // Guardrail at the boundary: read-only bridge refuses a destructive command.
    const roBridge = new McpBridge({
      sessionId,
      ssh: mgr,
      context,
      airGapped: true,
      policy: new Policy('read_only'),
      confirm: async () => 'approved' as const
    })
    const roInfo = await roBridge.start()
    const roClient = new Client({ name: 'ro', version: '0.1.0' })
    await roClient.connect(
      new StreamableHTTPClientTransport(new URL(roInfo.url), {
        requestInit: { headers: { Authorization: `Bearer ${roInfo.token}` } }
      })
    )
    const blocked = await roClient.callTool({ name: 'run_command', arguments: { command: 'rm -rf /etc' } })
    check('mcp read-only host blocks destructive run_command', (blocked as { isError?: boolean }).isError === true)
    await roClient.close()
    await roBridge.stop()
  } catch (e) {
    check('mcp bridge scenario', false, String((e as Error).message || e))
  } finally {
    await withTimeout(client?.close() ?? Promise.resolve(), 3000)
    await withTimeout(bridge?.stop() ?? Promise.resolve(), 3000)
    srv.close()
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

export async function runSelfTest(): Promise<boolean> {
  console.log('=== DevTerm self-test ===  defaultShell=' + defaultShell())
  await testLocalShell()
  await testSshScenario('linux')
  await testSshScenario('windows')
  await testSftp()
  testPolicy()
  await testBridge()

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  console.log(failed.length === 0 ? 'SELFTEST PASS' : 'SELFTEST FAIL')
  return failed.length === 0
}
