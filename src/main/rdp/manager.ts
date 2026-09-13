import { spawn, type ChildProcess } from 'child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type { RdpStatus, SSHProfile } from '@shared/types'

export interface RdpConnectResult {
  sessionId: string
}

interface RdpSession {
  id: string
  profile: SSHProfile
  proc?: ChildProcess
  dir: string
  target: string
}

function rdpTarget(profile: SSHProfile): string {
  const port = profile.port && profile.port !== 3389 ? profile.port : 3389
  return port === 3389 ? profile.host : profile.host + ':' + port
}

function writeRdpFile(dir: string, profile: SSHProfile): string {
  const target = rdpTarget(profile)
  const user = profile.domain ? profile.domain + '\\' + profile.username : profile.username
  const body = [
    'full address:s:' + target,
    'username:s:' + user,
    'prompt for credentials:i:0',
    'authentication level:i:0',
    'negotiate security layer:i:1',
    'enablecredsspsupport:i:1',
    'screen mode id:i:2',
    'smart sizing:i:1'
  ].join('\r\n')
  const path = join(dir, 'session.rdp')
  writeFileSync(path, body)
  return path
}

function run(cmd: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { windowsHide: true })
    let stdout = ''
    let stderr = ''
    proc.stdout?.on('data', (d) => { stdout += String(d) })
    proc.stderr?.on('data', (d) => { stderr += String(d) })
    proc.on('close', (code) => resolve({ code, stdout, stderr }))
    proc.on('error', (err) => resolve({ code: 1, stdout: '', stderr: err.message }))
  })
}

export class RdpManager {
  private sessions = new Map<string, RdpSession>()
  constructor(private onStatus: (id: string, status: RdpStatus) => void) {}

  async connect(profile: SSHProfile): Promise<RdpConnectResult> {
    if (process.platform !== 'win32') {
      throw new Error('RDP connections are available on Windows hosts running DevTerm')
    }
    const sessionId = profile.id || randomUUID()
    const dir = mkdtempSync(join(tmpdir(), 'devterm-rdp-'))
    const target = rdpTarget(profile)
    const rec: RdpSession = { id: sessionId, profile, dir, target }
    this.sessions.set(sessionId, rec)
    this.onStatus(sessionId, { type: 'connecting' })
    try {
      const user = profile.domain ? profile.domain + '\\' + profile.username : profile.username
      if (profile.password) {
        const stored = await run('cmdkey.exe', [
          '/generic:TERMSRV/' + profile.host,
          '/user:' + user,
          '/pass:' + profile.password
        ])
        if (stored.code !== 0) {
          throw new Error(stored.stderr.trim() || stored.stdout.trim() || 'cmdkey failed')
        }
      }
      const rdpFile = writeRdpFile(dir, profile)
      const proc = spawn('mstsc.exe', [rdpFile], { detached: false, windowsHide: false })
      rec.proc = proc
      proc.on('error', (err) => {
        this.onStatus(sessionId, { type: 'error', message: err.message })
      })
      proc.on('exit', () => {
        this.onStatus(sessionId, { type: 'closed' })
      })
      this.onStatus(sessionId, { type: 'connected' })
      return { sessionId }
    } catch (err) {
      this.disconnect(sessionId)
      throw err
    }
  }

  focus(sessionId: string): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    void run('mstsc.exe', [join(s.dir, 'session.rdp')])
  }

  disconnect(sessionId: string): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    this.sessions.delete(sessionId)
    try { s.proc?.kill() } catch { /* ignore */ }
    void run('cmdkey.exe', ['/delete:TERMSRV/' + s.profile.host])
    try { rmSync(s.dir, { recursive: true, force: true }) } catch { /* ignore */ }
    this.onStatus(sessionId, { type: 'closed' })
  }

  disconnectAll(): void {
    for (const id of [...this.sessions.keys()]) this.disconnect(id)
  }
}


