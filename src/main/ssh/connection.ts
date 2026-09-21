import { dialog } from 'electron'
import { Socket } from 'net'
import { Client, type ConnectConfig, type KexAlgorithm } from 'ssh2'
import type { SSHHop, SSHProfile, SSHStatus } from '@shared/types'
import { listJumpHops } from '@shared/ssh-jump'
import { authConfig, mapAuthError, missingAgentPathError } from './auth'
import { trustHostKey, verifyHostKey } from './knownHosts'

/** How long a bare TCP connect may take before we give up (OS SYN timeouts run ~2min). */
const TCP_CONNECT_TIMEOUT_MS = 15000

const LEGACY_WINDOWS_KEX: KexAlgorithm[] = [
  'curve25519-sha256@libssh.org',
  'curve25519-sha256',
  'ecdh-sha2-nistp256',
  'ecdh-sha2-nistp384',
  'ecdh-sha2-nistp521',
  'diffie-hellman-group14-sha256',
  'diffie-hellman-group15-sha512',
  'diffie-hellman-group16-sha512',
  'diffie-hellman-group17-sha512',
  'diffie-hellman-group18-sha512',
  // Old Win32-OpenSSH releases often offer fixed group14/SHA-1 and the much
  // slower group-exchange/SHA-256. Keep all modern fixed-group options first,
  // then narrowly allow group14/SHA-1 on auxiliary transports after the target
  // is known to be Windows. Never enable group1 or group-exchange/SHA-1.
  'diffie-hellman-group14-sha1',
  'diffie-hellman-group-exchange-sha256'
]

export interface EstablishOptions {
  /** Use the low-latency KEX order for auxiliary clients on a known Windows host. */
  preferLegacyWindowsKex?: boolean
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
  onStatus: (s: SSHStatus) => void,
  options: EstablishOptions = {}
): Promise<Client> {
  const missingAgent = missingAgentPathError(hop)
  if (missingAgent) {
    onStatus({ type: 'error', message: missingAgent.message })
    throw missingAgent
  }
  // Direct hops dial their own TCP_NODELAY socket; tunneled hops reuse the
  // bastion's forwarded stream (whose underlying socket already has NoDelay set).
  const transport = sock ?? (await tcpNoDelay(hop.host, hop.port))
  return new Promise((resolve, reject) => {
    const client = new Client()
    const hostId = `${hop.host}:${hop.port}`

    client
      .on('ready', () => resolve(client))
      .on('error', (err) => {
        const mapped = mapAuthError(err, hop)
        onStatus({ type: 'error', message: mapped.message })
        reject(mapped)
      })

    client.connect({
      host: hop.host,
      port: hop.port,
      username: hop.username,
      ...authConfig(hop),
      sock: transport as ConnectConfig['sock'],
      keepaliveInterval: 15000,
      readyTimeout: 20000,
      // Windows OpenSSH / older servers still offer ssh-rsa (and rarely ssh-dss).
      // Keep modern keys first; omit a category and ssh2 uses its defaults.
      algorithms: {
        ...(options.preferLegacyWindowsKex ? { kex: LEGACY_WINDOWS_KEX } : {}),
        serverHostKey: [
          'ssh-ed25519',
          'ecdsa-sha2-nistp256',
          'ecdsa-sha2-nistp384',
          'ecdsa-sha2-nistp521',
          'rsa-sha2-512',
          'rsa-sha2-256',
          'ssh-rsa',
          'ssh-dss'
        ]
      },
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
  /** First bastion client, kept for older cleanup sites. */
  jump?: Client
  /** Every ProxyJump client that must stay alive for the tunnel. */
  jumps?: Client[]
}

function forwardOut(client: Client, host: string, port: number): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) => {
    client.forwardOut('127.0.0.1', 0, host, port, (err, ch) => {
      if (err) reject(err)
      else resolve(ch as unknown as NodeJS.ReadableStream)
    })
  })
}

/**
 * Establish a client to the target, chaining through 0–2 ProxyJump hops
 * (total hops including the target ≤ 3). Direct hops keep TCP_NODELAY.
 */
export async function establish(
  profile: SSHHop & { jump?: SSHHop | SSHHop[] },
  onStatus: (s: SSHStatus) => void,
  options: EstablishOptions = {}
): Promise<EstablishedClient> {
  const hops = listJumpHops(profile.jump as SSHProfile['jump'])
  if (!hops.length) {
    const client = await connectHop(profile, undefined, onStatus, options)
    return { client }
  }

  const jumps: Client[] = []
  let stream: NodeJS.ReadableStream | undefined
  try {
    for (let i = 0; i < hops.length; i++) {
      const hop = hops[i]!
      const next = hops[i + 1] ?? profile
      const client = await connectHop(hop, stream, onStatus)
      jumps.push(client)
      stream = await forwardOut(client, next.host, next.port)
    }
    const client = await connectHop(profile, stream, onStatus, options)
    return { client, jump: jumps[0], jumps }
  } catch (err) {
    for (const j of jumps) {
      try {
        j.end()
      } catch {
        /* ignore */
      }
    }
    throw err
  }
}
