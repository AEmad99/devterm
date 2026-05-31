// Headless Electron smoke test for Phase 0/1 acceptance:
//   - node-pty and ssh2 load under Electron's ABI
//   - a real PTY spawns and produces output
// Run with: npx electron scripts/smoke.cjs   (exits 0 on success, 1 on failure)
const { app } = require('electron')

function fail(msg, err) {
  console.error('SMOKE FAIL:', msg, err ? '\n' + (err.stack || err) : '')
  app.exit(1)
}

app.disableHardwareAcceleration()

app.whenReady().then(() => {
  let pty, ssh2
  try {
    pty = require('node-pty')
    console.log('OK  node-pty loaded; abi=electron-v' + process.versions.modules)
  } catch (e) {
    return fail('node-pty failed to load', e)
  }
  try {
    ssh2 = require('ssh2')
    console.log('OK  ssh2 loaded; has Client=' + (typeof ssh2.Client === 'function'))
  } catch (e) {
    return fail('ssh2 failed to load', e)
  }

  const isWin = process.platform === 'win32'
  const shell = isWin ? 'cmd.exe' : '/bin/sh'
  const args = isWin ? ['/c', 'echo', 'pty_smoke_ok'] : ['-c', 'echo pty_smoke_ok']

  let buf = ''
  let done = false
  let proc
  try {
    proc = pty.spawn(shell, args, { name: 'xterm-256color', cols: 80, rows: 24, cwd: process.cwd(), env: process.env })
  } catch (e) {
    return fail('pty.spawn threw', e)
  }

  const timer = setTimeout(() => {
    if (!done) fail('timed out waiting for pty output; got: ' + JSON.stringify(buf))
  }, 8000)

  proc.onData((d) => { buf += d })
  proc.onExit(({ exitCode }) => {
    done = true
    clearTimeout(timer)
    if (buf.includes('pty_smoke_ok')) {
      console.log('OK  pty produced expected output (exit ' + exitCode + ')')
      console.log('SMOKE PASS')
      app.exit(0)
    } else {
      fail('pty output missing marker; got: ' + JSON.stringify(buf))
    }
  })
}).catch((e) => fail('app.whenReady rejected', e))
