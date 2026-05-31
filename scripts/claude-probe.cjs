// Probe: spawn `claude` in a node-pty exactly like the app, capture output + exit.
const { app } = require('electron')
const pty = require('node-pty')
const { execSync } = require('child_process')
const { mkdtempSync, writeFileSync } = require('fs')
const { tmpdir } = require('os')
const { join } = require('path')

app.disableHardwareAcceleration()
app.whenReady().then(() => {
  const cwd = mkdtempSync(join(tmpdir(), 'claude-probe-'))
  writeFileSync(join(cwd, 'mcp-config.json'), JSON.stringify({ mcpServers: {} }))
  const bin = execSync('where claude', { encoding: 'utf8' }).split(/\r?\n/)[0].trim()

  const mode = process.argv.includes('--interactive')
  const args = mode
    ? ['--mcp-config', join(cwd, 'mcp-config.json'), '--allowedTools', 'mcp__devterm__*,Read,Write']
    : ['--version']
  console.log(`bin=${bin}\nargs=${JSON.stringify(args)}\ncwd=${cwd}\n---`)

  let buf = ''
  const p = pty.spawn(bin, args, { name: 'xterm-256color', cols: 100, rows: 30, cwd, env: process.env })
  p.onData((d) => {
    buf += d
    process.stdout.write(d)
  })
  p.onExit(({ exitCode, signal }) => {
    console.log(`\n[EXIT] code=${exitCode} signal=${signal} bytes=${buf.length}`)
    app.exit(0)
  })
  setTimeout(() => {
    console.log(`\n[still running after 6s — good. bytes=${buf.length}] killing`)
    p.kill()
    app.exit(0)
  }, 6000)
})
