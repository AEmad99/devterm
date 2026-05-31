import type { Client } from 'ssh2'
import type { HostContext, HostOS } from '@shared/types'

/** Run a one-shot command over the SSH client and collect stdout/stderr/exit. */
function exec(
  client: Client,
  command: string,
  timeoutMs = 6000
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    let settled = false
    const done = (r: { stdout: string; stderr: string; code: number | null }) => {
      if (!settled) {
        settled = true
        resolve(r)
      }
    }
    const timer = setTimeout(() => done({ stdout: '', stderr: 'timeout', code: null }), timeoutMs)
    client.exec(command, (err, stream) => {
      if (err) {
        clearTimeout(timer)
        return done({ stdout: '', stderr: String(err.message || err), code: null })
      }
      let stdout = ''
      let stderr = ''
      let code: number | null = null
      stream
        .on('close', (c: number) => {
          clearTimeout(timer)
          code = c ?? code
          done({ stdout, stderr, code })
        })
        .on('data', (d: Buffer) => (stdout += d.toString()))
        .stderr.on('data', (d: Buffer) => (stderr += d.toString()))
    })
  })
}

function classify(uname: string): HostOS {
  const u = uname.toLowerCase()
  if (u.includes('linux')) return 'linux'
  if (u.includes('darwin')) return 'mac'
  if (u.includes('mingw') || u.includes('msys') || u.includes('cygwin') || u.includes('windows'))
    return 'windows'
  return 'unknown'
}

/**
 * Detect the remote OS by probing with `uname`. Unix-likes answer cleanly; a
 * Windows remote (OpenSSH default shell = cmd.exe/powershell) fails `uname`,
 * so we fall back to a Windows-only probe.
 */
export async function detectRemoteContext(client: Client): Promise<HostContext> {
  const uname = await exec(client, 'uname -a')
  if (uname.code === 0 && uname.stdout.trim()) {
    const detail = uname.stdout.trim()
    const host = await exec(client, 'hostname')
    return {
      kind: 'remote',
      os: classify(detail),
      detail,
      hostname: host.stdout.trim() || detail.split(' ')[1] || 'remote'
    }
  }

  // Not Unix-like → assume Windows; confirm with a cmd-style probe.
  const ver = await exec(client, 'cmd /c "ver & hostname"')
  const out = (ver.stdout || ver.stderr).trim()
  return {
    kind: 'remote',
    os: 'windows',
    detail: out || 'Windows (uname unavailable)',
    hostname: out.split(/\r?\n/).pop()?.trim() || 'remote'
  }
}
