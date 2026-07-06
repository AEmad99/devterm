/**
 * SSH port forwarding on the existing ssh2 client.
 *
 * Each forward owns a local TCP server. For `local` (-L) forwards, incoming
 * connections open a `forwardOut` channel on the session's client and pipe
 * bytes in both directions. Dynamic (-D) SOCKS forwards are reserved for a
 * future iteration; the type surface accepts the kind but the implementation
 * rejects it with a clear message.
 */

import { randomUUID } from 'crypto'
import { createServer, type Server } from 'net'
import type { Client } from 'ssh2'
import type { PortForward, PortForwardKind } from '@shared/types'

interface ForwardEntry {
  forward: PortForward
  server: Server
  sessionId: string
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
    if (kind === 'dynamic') {
      throw new Error('Dynamic (-D) SOCKS forwards are not implemented yet')
    }
    if (!remoteHost || remotePort == null) {
      throw new Error('Local forwards require a remote host and port')
    }

    const client = this.getClient(sessionId)
    if (!client) throw new Error('SSH session not connected')

    const id = this.makeId()
    const server = createServer((local) => {
      client.forwardOut('127.0.0.1', localPort, remoteHost, remotePort, (err, stream) => {
        if (err) {
          local.end()
          return
        }
        const entry = this.forwards.get(id)
        local.on('data', (d) => {
          if (entry) entry.bytesIn += d.length
        })
        stream.on('data', (d: Buffer) => {
          if (entry) entry.bytesOut += d.length
        })
        local.pipe(stream).pipe(local)
        local.on('close', () => {
          try {
            stream.close()
          } catch {
            /* ignore */
          }
        })
        stream.on('close', () => {
          try {
            local.end()
          } catch {
            /* ignore */
          }
        })
      })
    })

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(localPort, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })

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
    this.forwards.set(id, { forward, server, sessionId, bytesIn: 0, bytesOut: 0 })
    return forward
  }

  async remove(id: string): Promise<void> {
    const entry = this.forwards.get(id)
    if (!entry) return
    this.forwards.delete(id)
    await new Promise<void>((resolve) => {
      entry.server.close(() => resolve())
    })
  }

  removeBySession(sessionId: string): void {
    for (const [id, entry] of this.forwards.entries()) {
      if (entry.sessionId === sessionId) {
        this.forwards.delete(id)
        entry.server.close()
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
