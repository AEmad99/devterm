import type { Client } from 'ssh2'
import type { HostContext, HostOS } from '@shared/types'

/** Run a one-shot command over the SSH client and collect stdout/stderr/exit. */
function exec(
  client: Client,
  command: string,
  timeoutMs = 6000,
  signal?: AbortSignal
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    let settled = false
    const done = (r: { stdout: string; stderr: string; code: number | null }) => {
      if (!settled) {
        settled = true
        signal?.removeEventListener('abort', onAbort)
        resolve(r)
      }
    }
    // After a timeout the stream may keep running on the host; drop our
    // listeners so we don't buffer its output forever.
    const detach = (stream?: import('ssh2').ClientChannel) => {
      if (!stream) return
      stream.removeAllListeners('data')
      stream.stderr.removeAllListeners('data')
    }
    let streamRef: import('ssh2').ClientChannel | undefined
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    const timer = setTimeout(() => {
      detach(streamRef)
      try {
        streamRef?.close()
      } catch {
        /* ignore */
      }
      done({ stdout: '', stderr: 'timeout', code: null })
    }, timeoutMs)
    const onAbort = () => {
      clearTimeout(timer)
      detach(streamRef)
      try {
        streamRef?.close()
      } catch {
        /* ignore */
      }
      done({ stdout: '', stderr: 'SSH transport closed during startup', code: null })
    }
    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    client.exec(command, (err, stream) => {
      if (err) {
        clearTimeout(timer)
        return done({ stdout: '', stderr: String(err.message || err), code: null })
      }
      // A channel-open callback can arrive after our timeout. Never leave that
      // stale exec running: the caller may already be opening the interactive
      // shell, and restricted servers can reset the transport when the two
      // session channels overlap.
      if (settled) {
        stream.on('error', () => undefined)
        try {
          stream.close()
        } catch {
          /* ignore */
        }
        return
      }
      streamRef = stream
      stream
        .on('close', (c: number) => {
          clearTimeout(timer)
          // Decode once on completion so multi-byte UTF-8 split across ssh2
          // data chunks isn't mangled into U+FFFD.
          const stdout = Buffer.concat(stdoutChunks).toString('utf8')
          const stderr = Buffer.concat(stderrChunks).toString('utf8')
          done({ stdout, stderr, code: c ?? null })
        })
        .on('error', (streamError: Error) => {
          clearTimeout(timer)
          done({ stdout: '', stderr: streamError.message, code: null })
        })
        .on('data', (d: Buffer) => {
          if (!settled) stdoutChunks.push(d)
        })
        .stderr.on('data', (d: Buffer) => {
          if (!settled) stderrChunks.push(d)
        })
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
export async function detectRemoteContext(
  client: Client,
  execTimeoutMs = 6000,
  signal?: AbortSignal
): Promise<HostContext> {
  const uname = await exec(client, 'uname -a', execTimeoutMs, signal)
  if (signal?.aborted) throw new Error('SSH transport closed during startup')
  if (uname.code === 0 && uname.stdout.trim()) {
    const detail = uname.stdout.trim()
    const host = await exec(client, 'hostname', execTimeoutMs, signal)
    if (signal?.aborted) throw new Error('SSH transport closed during startup')
    return {
      kind: 'remote',
      os: classify(detail),
      detail,
      hostname: host.stdout.trim() || detail.split(' ')[1] || 'remote'
    }
  }

  // Not Unix-like → assume Windows; confirm with a cmd-style probe.
  const ver = await exec(client, 'cmd /c "ver & hostname"', execTimeoutMs, signal)
  if (signal?.aborted) throw new Error('SSH transport closed during startup')
  const out = (ver.stdout || ver.stderr).trim()
  return {
    kind: 'remote',
    os: 'windows',
    detail: out || 'Windows (uname unavailable)',
    hostname: out.split(/\r?\n/).pop()?.trim() || 'remote'
  }
}
