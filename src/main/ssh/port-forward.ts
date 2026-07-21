/**
 * SSH port forwarding on the existing ssh2 client.
 *
 *  - `local` (-L): one `net.Server` on `127.0.0.1:port`. Each accepted socket
 *    opens a `forwardOut` to the configured remote host:port and pipes
 *    bytes both ways.
 *  - `dynamic` (-D): one `net.Server` on `127.0.0.1:port` running a minimal
 *    SOCKS5 server (no auth, CONNECT only). Each client sends a CONNECT
 *    request; the dst host:port is parsed and tunneled through the SSH
 *    session via `forwardOut`. Multiple concurrent clients share the same
 *    listening port — the listening port is the bottleneck, not the SSH
 *    channel.
 *
 * Forward specs are kept in the manager so they survive transport reconnects:
 * listeners are suspended when the session drops and re-bound (via
 * {@link PortForwardManager.rebind}) once SSH is back. The ssh2 client is
 * resolved per accepted connection through the injected `getClient`, never
 * captured at add-time.
 *
 * Bytes are counted in both directions and summed in `list()`.
 */

import { randomUUID } from 'crypto'
import { createServer, type Server, type Socket } from 'net'
import type { Client } from 'ssh2'
import type { PortForward, PortForwardKind } from '@shared/types'

interface ForwardEntry {
  forward: PortForward
  /**
   * Live listener, or undefined while the session is down (suspended). The
   * entry stays so a reconnect can re-establish it.
   */
  server?: Server
  sessionId: string
  kind: PortForwardKind
  localPort: number
  remoteHost?: string
  remotePort?: number
  bytesIn: number
  bytesOut: number
}

export class PortForwardManager {
  private forwards = new Map<string, ForwardEntry>()
  private getClient: (sessionId: string) => Client | undefined

  constructor(getClient: (sessionId: string) => Client | undefined) {
    this.getClient = getClient
  }

  private makeId(): string {
    return `pf-${randomUUID()}`
  }

  async add(
    sessionId: string,
    kind: PortForwardKind,
    localPort: number,
    remoteHost?: string,
    remotePort?: number
  ): Promise<PortForward> {
    if (!this.getClient(sessionId)) throw new Error('SSH session not connected')
    if (kind === 'local' && (!remoteHost || remotePort == null)) {
      throw new Error('Local forwards require a remote host and port')
    }

    const id = this.makeId()
    const forward: PortForward = {
      id,
      sessionId,
      kind,
      localPort,
      remoteHost,
      remotePort,
      createdAt: Date.now(),
      bytes: 0
    }
    const entry: ForwardEntry = {
      forward,
      sessionId,
      kind,
      localPort,
      remoteHost,
      remotePort,
      bytesIn: 0,
      bytesOut: 0
    }

    entry.server = await this.bindServer(entry)
    this.forwards.set(id, entry)
    return forward
  }

  /**
   * Create the listening server for an entry and start listening. The ssh2
   * client is resolved per accepted connection so a reconnect swaps in the
   * fresh client without re-creating the server.
   */
  private bindServer(entry: ForwardEntry): Promise<Server> {
    const server =
      entry.kind === 'local'
        ? this.createLocalServer(entry)
        : // Dynamic (-D) SOCKS5: the listening port handles many clients,
          // each forwarding to its own chosen destination over a separate
          // `forwardOut` channel.
          this.createDynamicServer(entry)

    return new Promise<Server>((resolve, reject) => {
      server.once('error', reject)
      server.listen(entry.localPort, '127.0.0.1', () => {
        server.off('error', reject)
        resolve(server)
      })
    })
  }

  private createLocalServer(entry: ForwardEntry): Server {
    return createServer((local) => {
      const client = this.getClient(entry.sessionId)
      if (!client) {
        local.end()
        return
      }
      client.forwardOut('127.0.0.1', 0, entry.remoteHost!, entry.remotePort!, (err, stream) => {
        if (err) {
          local.end()
          return
        }
        this.pipeSocket(entry.forward.id, local, stream)
      })
    })
  }

  private createDynamicServer(entry: ForwardEntry): Server {
    return createServer((local) => {
      // SOCKS5 no-auth greeting, then CONNECT, then forward.
      socks5Handshake(local)
        .then((target) => {
          if (!target) {
            local.end()
            return
          }
          const client = this.getClient(entry.sessionId)
          if (!client) {
            local.write(Buffer.from([0x05, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
            local.end()
            return
          }
          client.forwardOut('127.0.0.1', 0, target.host, target.port, (err, stream) => {
            if (err) {
              // Reply with a generic SOCKS failure (0x05 0x01 0x00 0x01
              // …) and close. Most clients will surface a clear error.
              local.write(Buffer.from([0x05, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
              local.end()
              return
            }
            // Reply success (VER=5, REP=0, RSV=0, ATYP=1 IPv4, 0.0.0.0:0)
            // before piping — clients won't start sending the proxied
            // payload until they see this.
            local.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
            this.pipeSocket(entry.forward.id, local, stream)
          })
        })
        .catch(() => {
          local.end()
        })
    })
  }

  private pipeSocket(id: string, local: Socket, stream: import('stream').Duplex): void {
    const entry = this.forwards.get(id)
    local.on('data', (d) => {
      if (entry) entry.bytesIn += d.length
    })
    stream.on('data', (d: Buffer) => {
      if (entry) entry.bytesOut += d.length
    })
    local.pipe(stream).pipe(local)
    const closeBoth = () => {
      try {
        local.end()
      } catch {
        /* ignore */
      }
      try {
        stream.end()
      } catch {
        /* ignore */
      }
    }
    local.on('close', closeBoth)
    stream.on('close', closeBoth)
    local.on('error', closeBoth)
    stream.on('error', closeBoth)
  }

  async remove(id: string): Promise<void> {
    const entry = this.forwards.get(id)
    if (!entry) return
    this.forwards.delete(id)
    if (!entry.server) return
    await new Promise<void>((resolve) => {
      entry.server!.close(() => resolve())
    })
  }

  removeBySession(sessionId: string): void {
    for (const [id, entry] of this.forwards.entries()) {
      if (entry.sessionId === sessionId) {
        this.forwards.delete(id)
        entry.server?.close()
      }
    }
  }

  /**
   * Suspend a session's forwards without forgetting their specs — used when
   * the SSH transport drops. Listeners are closed (accepting on them would
   * only produce dead channels); {@link rebind} brings them back.
   */
  suspendBySession(sessionId: string): void {
    for (const entry of this.forwards.values()) {
      if (entry.sessionId === sessionId && entry.server) {
        entry.server.close()
        entry.server = undefined
      }
    }
  }

  /**
   * Re-establish listeners for a session's suspended forwards after a
   * successful reconnect. Entries whose port can no longer be bound are
   * dropped (the local port may have been taken while the session was down).
   */
  async rebind(sessionId: string): Promise<void> {
    for (const [id, entry] of [...this.forwards.entries()]) {
      if (entry.sessionId !== sessionId || entry.server) continue
      try {
        entry.server = await this.bindServer(entry)
      } catch {
        this.forwards.delete(id)
      }
    }
  }

  list(sessionId?: string): PortForward[] {
    const all = Array.from(this.forwards.values()).map((e) => {
      const f = { ...e.forward }
      f.bytes = e.bytesIn + e.bytesOut
      return f
    })
    if (sessionId == null) return all
    return all.filter((f) => f.sessionId === sessionId)
  }
}

/**
 * Minimal SOCKS5 (RFC 1928) no-auth + CONNECT handshake.
 * Returns the requested host:port or null on protocol error / unsupported
 * command / missing parameters.
 *
 *  - Greeting: client sends VER=5, NMETHODS, METHODS. We reply with
 *    VER=5, METHOD=0 (no auth).
 *  - Request: VER=5, CMD, RSV, ATYP, DST.ADDR, DST.PORT. We only support
 *    CMD=1 (CONNECT) and ATYP=1 (IPv4) or ATYP=3 (DOMAINNAME).
 *
 * A `phase` flag tracks where we are across `data` events: greeting and
 * request routinely arrive in separate TCP segments (many clients wait for
 * the method reply before sending the request), and either packet may also
 * be split mid-message. Re-parsing from byte 0 on every chunk would corrupt
 * the protocol by writing a second method reply.
 */
function socks5Handshake(socket: Socket): Promise<{ host: string; port: number } | null> {
  return new Promise((resolve) => {
    let buf = Buffer.alloc(0)
    let phase: 'greeting' | 'request' = 'greeting'
    const done = (v: { host: string; port: number } | null) => {
      socket.off('data', onData)
      socket.off('error', onError)
      socket.off('close', onClose)
      resolve(v)
    }
    const onError = () => done(null)
    const onClose = () => done(null)
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk])
      try {
        // 1. Greeting: VER(1) NMETHODS(1) METHODS(NMETHODS)
        if (phase === 'greeting') {
          if (buf.length < 2) return
          if (buf[0] !== 0x05) return done(null)
          const nMethods = buf[1]
          if (buf.length < 2 + nMethods) return
          // Reply: VER=5, METHOD=0 (no auth)
          socket.write(Buffer.from([0x05, 0x00]))
          buf = buf.subarray(2 + nMethods)
          phase = 'request'
        }
        // 2. Request: VER(1) CMD(1) RSV(1) ATYP(1) [ADDR] [PORT(2)]
        if (buf.length < 4) return
        if (buf[0] !== 0x05) return done(null)
        const cmd = buf[1]
        if (cmd !== 0x01) return done(null) // CONNECT only
        const atyp = buf[3]
        let host: string
        let offset: number
        if (atyp === 0x01) {
          // IPv4: 4 bytes
          if (buf.length < 4 + 4 + 2) return
          host = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`
          offset = 8
        } else if (atyp === 0x03) {
          // Domain: 1 length byte + N bytes
          if (buf.length < 5) return
          const len = buf[4]
          if (buf.length < 4 + 1 + len + 2) return
          host = buf.subarray(5, 5 + len).toString('utf8')
          offset = 5 + len
        } else if (atyp === 0x04) {
          // IPv6: 16 bytes
          if (buf.length < 4 + 16 + 2) return
          const parts: string[] = []
          for (let i = 0; i < 8; i++) {
            parts.push(buf.readUInt16BE(4 + i * 2).toString(16))
          }
          host = parts.join(':')
          offset = 20
        } else {
          return done(null)
        }
        const port = buf.readUInt16BE(offset)
        done({ host, port })
      } catch {
        done(null)
      }
    }
    socket.on('data', onData)
    socket.on('error', onError)
    socket.on('close', onClose)
  })
}
