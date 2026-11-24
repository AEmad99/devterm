import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { IPty } from 'node-pty'
import {
  blockedNativePath,
  inboxConsoleNotice,
  openLocalPty,
  resolveInboxConsoleLaunch,
  shouldFallbackFromPtyError,
  spawnPipePty,
  windowsPipeInput
} from './pty-fallback'

const SCREENSHOT_ERROR = new Error(
  'An Application Control policy has blocked this file.\n' +
    '\\\\?\\C:\\Users\\mmgha\\AppData\\Local\\Programs\\DevTerm\\resources\\app.asar.unpacked\\node_modules\\node-pty\\build\\Release\\conpty.node'
)

describe('Windows terminal fallback when Application Control blocks conpty.node', () => {
  it('recognizes the policy block from a packaged install', () => {
    assert.equal(shouldFallbackFromPtyError(SCREENSHOT_ERROR), true)
    assert.equal(
      blockedNativePath(SCREENSHOT_ERROR),
      'C:\\Users\\mmgha\\AppData\\Local\\Programs\\DevTerm\\resources\\app.asar.unpacked\\node_modules\\node-pty\\build\\Release\\conpty.node'
    )
    assert.match(inboxConsoleNotice(SCREENSHOT_ERROR), /conpty\.node/)
    assert.match(inboxConsoleNotice(SCREENSHOT_ERROR), /console host/)
  })

  it('falls back for a missing or unloadable pty addon, and leaves other spawn errors alone', () => {
    assert.equal(
      shouldFallbackFromPtyError(new Error("Cannot find module '../build/Release/conpty.node'")),
      true
    )
    assert.equal(
      shouldFallbackFromPtyError(
        new Error('A dynamic link library (DLL) initialization routine failed.')
      ),
      false
    )
    assert.equal(shouldFallbackFromPtyError(new Error('spawn pwsh.exe ENOENT')), false)
  })

  it('launches the shell through conhost.exe when that host is on disk', () => {
    const launch = resolveInboxConsoleLaunch({
      shell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      args: ['-NoLogo', '-NoExit'],
      systemRoot: 'C:\\Windows',
      conhostExists: true
    })
    assert.equal(launch.file, 'C:\\Windows\\System32\\conhost.exe')
    assert.deepEqual(launch.args, [
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      '-NoLogo',
      '-NoExit'
    ])
    assert.equal(launch.via, 'conhost')
  })

  it('starts the shell directly when conhost.exe is absent', () => {
    const launch = resolveInboxConsoleLaunch({
      shell: 'C:\\Windows\\System32\\cmd.exe',
      args: [],
      systemRoot: 'C:\\Windows',
      conhostExists: false
    })
    assert.equal(launch.via, 'shell')
    assert.equal(launch.file, 'C:\\Windows\\System32\\cmd.exe')
    assert.deepEqual(launch.args, [])
  })

  it('turns xterm Enter into a Windows pipe newline', () => {
    assert.equal(windowsPipeInput('\r'), '\r\n')
    assert.equal(windowsPipeInput('dir\r'), 'dir\r\n')
    assert.equal(windowsPipeInput('dir\r\n'), 'dir\r\n')
    assert.equal(windowsPipeInput('hello'), 'hello')
  })

  it('uses the inbox console when the native spawn throws the policy error', () => {
    const launched: { file: string; args: string[] } = { file: '', args: [] }
    const fake: IPty = {
      pid: 42,
      process: 'conhost.exe',
      onData() {},
      onExit() {},
      write() {},
      resize() {},
      kill() {}
    }
    const opened = openLocalPty(
      'C:\\Windows\\System32\\cmd.exe',
      [],
      { cols: 80, rows: 24, cwd: 'C:\\Users\\mmgha' },
      {
        platform: 'win32',
        systemRoot: 'C:\\Windows',
        conhostExists: () => true,
        spawnNative: () => {
          throw SCREENSHOT_ERROR
        },
        spawnPipe: (file, args) => {
          launched.file = file
          launched.args = args
          return fake
        }
      }
    )
    assert.equal(opened.proc, fake)
    assert.match(opened.notice ?? '', /Application Control/)
    assert.equal(launched.file, 'C:\\Windows\\System32\\conhost.exe')
    assert.equal(launched.args[0], 'C:\\Windows\\System32\\cmd.exe')
  })

  it('does not hide a policy block on non-Windows', () => {
    assert.throws(
      () =>
        openLocalPty(
          '/bin/bash',
          [],
          { cwd: '/' },
          {
            platform: 'linux',
            spawnNative: () => {
              throw SCREENSHOT_ERROR
            }
          }
        ),
      /Application Control policy/
    )
  })
})

describe('spawnPipePty', () => {
  it('writes input and returns the child output', async () => {
    const proc = spawnPipePty(
      process.execPath,
      [
        '-e',
        'process.stdin.on("data", (d) => { process.stdout.write(d); if (String(d).includes("bye")) process.exit(0) })'
      ],
      { cwd: process.cwd(), cols: 80, rows: 24 }
    )
    const output = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('pipe pty produced no output')), 5000)
      proc.onData((data) => {
        clearTimeout(timer)
        resolve(data)
      })
      proc.onExit(() => {
        /* echo process exits after bye */
      })
      proc.write('bye')
    })
    assert.match(output, /bye/)
  })
})
