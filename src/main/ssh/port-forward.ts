// Cluster B — SSH port forwarding (channel-mux on the existing ssh2 client).
//
// Each forward lives on ONE ssh2 client — the one that already owns the SSH
// session. We never instantiate a second `new Client()` for forwarding: the
// remote host is already reachable through the manager's live client, so we
// just open a `forwardOut` channel on it and pipe that channel to a local
// listening socket.
//
//   local (-L) : client listens on `127.0.0.1:localPort`. On each accept, it
//                calls `client.forwardOut(srcIP, srcPort, remoteHost, remotePort)`
//                to open a fresh multiplexed channel back through the same
//                client. The local socket and the channel are piped together;
//                closing either tears down both.
//
//   dynamic (-D): not implemented in v1. SOCKS-over-SSH would mean running a
//                SOCKS5 protocol parser on the renderer/main boundary, which
//                is out of scope. `add()` rejects with a clear error so the UI
//                can show the limitation.
//
// Bytes are counted on both directions (`bytesIn` + `bytesOut`) by listening
// to the duplex stream's `data` events. The aggregate is exposed via `list()`
// for the SettingsModal's 2s polling — best-effort, may undershoot at process
// exit, but never overshoots (we never report bytes the kernel hasn't seen).

import { createServer, type Server, type Socket } from 'net'
import { randomUUID } from 'crypto'
import type { Client, ClientChannel } from 'ssh2'
import type { PortForward, PortForwardKind } from '@shared/types'

interface ForwardState {
  id: string
  sessionId: string
  kind: PortForwardKind
  localPort: number
  remoteHost?: string
  remotePort?: number
  createdAt: number
  server: Server
  /** Total bytes flowing client→channel (what the local app sends to the remote). */
  bytesIn: number
  /** Total bytes flowing channel→client (what the remote sends back to the local app). */
  bytesOut: number
  /** Active stream pairs (kept for cleanup and counting). */
  streams: Set<{ sock: Socket; ch: ClientChannel }>
}

const forwards = new Map<string, ForwardState>()

export class PortForwardError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PortForwardError'
  }
}

export interface AddRequest {
  sessionId: string
  kind: PortForwardKind
  localPort: number
  remoteHost?: string
  remotePort?: number
}

function validate(req: AddRequest): void {
  if (req.kind === 'dynamic') {
    throw new PortForwardError(
      'Dynamic (SOCKS) port forwards are not supported in this build. Use a local (-L) forward instead.'
    )
  }
  const localPort = Number(req.localPort)
  if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) {
    throw new PortForwardError(`Invalid local port: ${req.localPort}`)
  }
  if (req.kind === 'local') {
    if (!req.remoteHost || !req.remotePort) {
      throw new PortForwardError('Local forwards need both remote host and remote port')
    }
    const rp = Number(req.remotePort)
    if (!Number.isInteger(rp) || rp < 1 || rp > 65535) {
      throw new PortForwardError(`Invalid remote port: ${req.remotePort}`)
    }
  }
}

/**
 * Add a new port forward. The `client` is the session's live ssh2 client
 * (looked up by the manager; never created here). Returns the registry row.
 *
 * NOTE: validation order matters. We check `sessionId` + that the client is
 * connected BEFORE we touch the local listener, so a bad session never leaves
 * a dangling socket behind. Once we start the listener we own its cleanup
 * and tear it down on every error path.
 */
export function addAsync(
  client: Client | undefined,
  req: AddRequest
): Promise<PortForward> {
  if (!client) {
    return Promise.reject(
      new PortForwardError(
        'Session is not connected. Port forwards need a live SSH client — reconnect and try again.'
      )
    )
  }
  // Reject dynamic forwards with a clear error (see file header). Do this
  // before validation so the kind toggle in the UI gets the same message
  // regardless of what other fields are filled in.
  if (req.kind === 'dynamic') {
    return Promise.reject(
      new PortForwardError(
        'Dynamic (SOCKS) port forwards are not supported in this build. Use a local (-L) forward instead.'
      )
    )
  }
  try {
    validate(req)
  } catch (e) {
    return Promise.reject(e)
  }

  const id = randomUUID()
  const state: ForwardState = {
    id,
    sessionId: req.sessionId,
    kind: req.kind,
    localPort: Number(req.localPort),
    remoteHost: req.remoteHost,
    remotePort: req.remotePort,
    createdAt: Date.now(),
    server: createServer(),
    bytesIn: 0,
    bytesOut: 0,
    streams: new Set()
  }

  return new Promise<PortForward>((resolve, reject) => {
    const onInitialError = (err: Error) => {
      try {
        state.server.close()
      } catch {
        /* ignore */
      }
      reject(
        new PortForwardError(
          `Could not listen on 127.0.0.1:${state.localPort}: ${err.message}`
        )
      )
    }
    state.server.once('error', onInitialError)
    state.server.listen(state.localPort, '127.0.0.1', () => {
      state.server.removeListener('error', onInitialError)
      // From here on, every error path MUST call cleanup() so we don't leak
      // the listening socket or any open channels.
      const cleanup = (): void => {
        for (const { sock, ch } of state.streams) {
          try {
            ch.close()
          } catch {
            /* ignore */
          }
          try {
            sock.destroy()
          } catch {
            /* ignore */
          }
        }
        state.streams.clear()
        state.server.close()
        forwards.delete(id)
      }

      state.server.on('error', (err) => {
        console.warn(`port-forward ${id} server error:`, err)
        cleanup()
      })
      state.server.on('connection', (sock) => {
        // Each accept opens a new `forwardOut` channel on the SAME client
        // (channel-mux; never a second Client()). The local socket and the
        // channel are piped together; either side closing tears down both.
        client.forwardOut(
          '127.0.0.1',
          0,
          state.remoteHost ?? '127.0.0.1',
          state.remotePort ?? 0,
          (err, ch) => {
            if (err) {
              sock.destroy()
              return
            }
            const pair = { sock, ch }
            state.streams.add(pair)
            sock.on('data', (d: Buffer) => {
              state.bytesIn += d.length
            })
            ch.on('data', (d: Buffer) => {
              state.bytesOut += d.length
            })
            const onClose = (): void => {
              state.streams.delete(pair)
              try {
                ch.end()
              } catch {
                /* ignore */
              }
              try {
                sock.end()
              } catch {
                /* ignore */
              }
            }
            sock.on('close', onClose)
            sock.on('error', onClose)
            ch.on('close', onClose)
            ch.on('error', onClose)
            sock.pipe(ch)
            ch.pipe(sock)
          }
        )
      })

      forwards.set(id, state)
      resolve(toRow(state))
    })
  })
}

/** Stop + remove a forward by id. Idempotent. */
export function remove(id: string): void {
  const state = forwards.get(id)
  if (!state) return
  for (const { sock, ch } of state.streams) {
    try {
      ch.close()
    } catch {
      /* ignore */
    }
    try {
      sock.destroy()
    } catch {
      /* ignore */
    }
  }
  state.streams.clear()
  try {
    state.server.close()
  } catch {
    /* ignore */
  }
  forwards.delete(id)
}

/** List forwards. When `sessionId` is provided, filters to that session. */
export function list(sessionId?: string): PortForward[] {
  const all = Array.from(forwards.values())
  const filtered = sessionId == null ? all : all.filter((f) => f.sessionId === sessionId)
  return filtered.map(toRow)
}

/** Tear down every forward belonging to a session (called when the session disconnects). */
export function removeAllForSession(sessionId: string): void {
  for (const id of [...forwards.keys()]) {
    if (forwards.get(id)?.sessionId === sessionId) remove(id)
  }
}

/** Test-only: count active forwards (used by smoke tests if added later). */
export function _size(): number {
  return forwards.size
}

function toRow(s: ForwardState): PortForward {
  return {
    id: s.id,
    sessionId: s.sessionId,
    kind: s.kind,
    localPort: s.localPort,
    remoteHost: s.remoteHost,
    remotePort: s.remotePort,
    createdAt: s.createdAt,
    bytes: s.bytesIn + s.bytesOut
  }
}
