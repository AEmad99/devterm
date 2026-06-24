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
  // BSDs, Solaris/illumos, AIX, etc. are POSIX; we treat anything `uname`
  // answers to as a POSIX host (the OSC 7 hook runs in bash/zsh/POSIX sh on
  // all of them). Marking them 'unknown' would silently disable cwd tracking
  // and leave the agent's tools working in $HOME forever.
  if (u.includes('mingw') || u.includes('msys') || u.includes('cygwin') || u.includes('windows'))
    return 'windows'
  if (
    u.includes('freebsd') ||
    u.includes('openbsd') ||
    u.includes('netbsd') ||
    u.includes('dragonfly') ||
    u.includes('sunos') ||
    u.includes('solaris') ||
    u.includes('illumos') ||
    u.includes('aix') ||
    u.includes('hp-ux')
  )
    return 'posix'
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
    const os = classify(detail)
    const host = await exec(client, 'hostname')
    return {
      kind: 'remote',
      // 'unknown' from `uname` still means a POSIX host (the kernel string
      // didn't match any token we recognize) — fall through to the POSIX
      // branch so OSC 7 still gets installed and the agent's cwd tracking
      // works. The pre-fix code left these hosts with no cwd reporting at
      // all, which silently broke the agent's host tools on FreeBSD / Solaris.
      os: os === 'unknown' ? 'posix' : os,
      detail,
      hostname: host.stdout.trim() || detail.split(' ')[1] || 'remote'
    }
  }

  // Not Unix-like → assume Windows; confirm with a cmd-style probe. The
  // previous implementation unconditionally reported `os: 'windows'` when
  // `uname` failed, which lied about a Linux host with a stripped PATH (no
  // `uname` binary) or one whose `uname` had been deleted; that path then
  // probed for PowerShell, found bash, and silently disabled OSC 7. A
  // failed Windows probe (non-zero exit, no usable stdout) is now treated
  // as POSIX so the OSC 7 hook still runs.
  const ver = await exec(client, 'cmd /c "ver & hostname"')
  const out = (ver.stdout || ver.stderr).trim()
  if (ver.code === 0 && /windows/i.test(out)) {
    return {
      kind: 'remote',
      os: 'windows',
      detail: out || 'Windows (uname unavailable)',
      hostname: out.split(/\r?\n/).pop()?.trim() || 'remote'
    }
  }
  return {
    kind: 'remote',
    os: 'posix',
    detail: 'POSIX host (uname unavailable)',
    hostname: 'remote'
  }
}
