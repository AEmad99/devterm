import { dialog } from 'electron'
import { readFileSync } from 'fs'
import { Socket } from 'net'
import { Client, type ConnectConfig } from 'ssh2'
import type { SSHHop, SSHStatus } from '@shared/types'
import { trustHostKey, verifyHostKey } from './knownHosts'

/** How long a bare TCP connect may take before we give up (OS SYN timeouts run ~2min). */
const TCP_CONNECT_TIMEOUT_MS = 15000

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
    // Black-holed hosts never answer SYN, and ssh2's readyTimeout only starts
    // AFTER the socket connects — cap the dial ourselves.
    const onTimeout = () => {
      socket.destroy()
      reject(new Error(`TCP connect to ${host}:${port} timed out`))
    }
    socket.setTimeout(TCP_CONNECT_TIMEOUT_MS)
    socket.once('timeout', onTimeout)
    socket.once('error', onError)
    socket.connect(port, host, () => {
      socket.setTimeout(0)
      socket.removeListener('timeout', onTimeout)
      socket.setNoDelay(true)
      socket.removeListener('error', onError)
      resolve(socket)
    })
  })
}

/**
 * Ask the operator to trust a first-use host key (TOFU). The SHA256
 * fingerprint is shown so it can be compared out-of-band. Resolves true only
 * when the user explicitly accepts.
 */
async function promptTrustHostKey(hostId: string, fingerprint: string): Promise<boolean> {
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    title: 'Trust new SSH host key?',
    message: `Trust new SSH host key for ${hostId}?`,
    detail:
      `This is the first time DevTerm connects to this host.\n\n` +
      `Fingerprint: ${fingerprint}\n\n` +
      `Verify this fingerprint out-of-band before trusting it. It will be stored in known_hosts and ` +
      `future connections will warn if it changes.`,
    buttons: ['Trust and save', 'Reject'],
    defaultId: 1,
    cancelId: 1,
    noLink: true
  })
  return response === 0
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
      // Host-key verification (§7.1): TOFU with operator confirmation on
      // first use and mismatch rejection. ssh2 allows `verify` to be called
      // asynchronously, so the confirm dialog can resolve later.
      hostVerifier: (key: Buffer, verify: (valid: boolean) => void) => {
        const verdict = verifyHostKey(hostId, key)
        if (!verdict.ok) {
          onStatus({
            type: 'hostkey-mismatch',
            host: hostId,
            fingerprint: verdict.fingerprint,
            expected: verdict.expected
          })
          verify(false)
          return
        }
        if (!verdict.firstUse) {
          verify(true)
          return
        }
        // First contact: only trust the key after the operator confirms.
        void promptTrustHostKey(hostId, verdict.fingerprint)
          .then((trusted) => {
            if (trusted) {
              trustHostKey(hostId, verdict.fingerprint)
              onStatus({ type: 'hostkey-new', host: hostId, fingerprint: verdict.fingerprint })
            } else {
              onStatus({ type: 'error', message: `Host key for ${hostId} rejected by operator` })
            }
            verify(trusted)
          })
          .catch(() => verify(false))
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
