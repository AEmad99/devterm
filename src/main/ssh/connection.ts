import { readFileSync } from 'fs'
import { Socket } from 'net'
import { Client, type ConnectConfig } from 'ssh2'
import type { SSHHop, SSHStatus } from '@shared/types'
import { verifyHostKey } from './knownHosts'

function authConfig(hop: SSHHop): Partial<ConnectConfig> {
  const cfg: Partial<ConnectConfig> = {}
  if (hop.privateKeyPath) {
    cfg.privateKey = readFileSync(hop.privateKeyPath)
    if (hop.passphrase) cfg.passphrase = hop.passphrase
  }
  if (hop.password) cfg.password = hop.password
  return cfg
}

/**
 * Open a plain TCP socket with Nagle's algorithm disabled (TCP_NODELAY). ssh2
 * does not expose its socket so we can't set this after the fact, and without it
 * the OS buffers small interactive writes (tens of ms of latency per keystroke /
 * output chunk) — the classic "laggy SSH" feel. We dial the socket ourselves and
 * hand it to ssh2 via the `sock` option so every session is low-latency.
 */
function tcpNoDelay(host: string, port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = new Socket()
    const onError = (err: Error) => {
      socket.destroy()
      reject(err)
    }
    socket.once('error', onError)
    socket.connect(port, host, () => {
      socket.setNoDelay(true)
      socket.removeListener('error', onError)
      resolve(socket)
    })
  })
}

/** Connect one hop (optionally tunneled through an existing `sock`). */
async function connectHop(
  hop: SSHHop,
  sock: NodeJS.ReadableStream | undefined,
  onStatus: (s: SSHStatus) => void
): Promise<Client> {
  // Direct hops dial their own TCP_NODELAY socket; tunneled hops reuse the
  // bastion's forwarded stream (whose underlying socket already has NoDelay set).
  const transport = sock ?? (await tcpNoDelay(hop.host, hop.port))
  return new Promise((resolve, reject) => {
    const client = new Client()
    const hostId = `${hop.host}:${hop.port}`

    client
      .on('ready', () => resolve(client))
      .on('error', (err) => {
        onStatus({ type: 'error', message: err.message })
        reject(err)
      })

    client.connect({
      host: hop.host,
      port: hop.port,
      username: hop.username,
      ...authConfig(hop),
      sock: transport as ConnectConfig['sock'],
      keepaliveInterval: 15000,
      readyTimeout: 20000,
      // Host-key verification (§7.1): TOFU with mismatch rejection.
      hostVerifier: (key: Buffer, verify: (valid: boolean) => void) => {
        const verdict = verifyHostKey(hostId, key)
        if (verdict.ok) {
          if (verdict.firstUse)
            onStatus({ type: 'hostkey-new', host: hostId, fingerprint: verdict.fingerprint })
          verify(true)
        } else {
          onStatus({
            type: 'hostkey-mismatch',
            host: hostId,
            fingerprint: verdict.fingerprint,
            expected: verdict.expected
          })
          verify(false)
        }
      }
    })
  })
}

export interface EstablishedClient {
  client: Client
  /** Bastion client kept alive for the duration, if ProxyJump was used. */
  jump?: Client
}

/**
 * Establish a client to the target, chaining through a single bastion if the
 * profile specifies `jump`. Reuses one TCP tunnel — no second SSH process.
 */
export async function establish(
  profile: { jump?: SSHHop } & SSHHop,
  onStatus: (s: SSHStatus) => void
): Promise<EstablishedClient> {
  if (!profile.jump) {
    const client = await connectHop(profile, undefined, onStatus)
    return { client }
  }

  const jump = await connectHop(profile.jump, undefined, onStatus)
  const stream = await new Promise<NodeJS.ReadableStream>((resolve, reject) => {
    jump.forwardOut('127.0.0.1', 0, profile.host, profile.port, (err, ch) => {
      if (err) reject(err)
      else resolve(ch as unknown as NodeJS.ReadableStream)
    })
  })
  try {
    const client = await connectHop(profile, stream, onStatus)
    return { client, jump }
  } catch (err) {
    jump.end()
    throw err
  }
}
