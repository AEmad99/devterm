import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import { randomBytes, randomUUID, timingSafeEqual } from 'crypto'
import type { AddressInfo, Socket } from 'net'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import type { AgentBridgeState, AgentBridgeStatus } from '@shared/types'
import { registerTools, type ToolDeps } from './tools'
import { recordBridgeActivity } from '../ipc/foundation'

const BRIDGE_HEARTBEAT_MS = 25000
const MAX_REQUEST_BYTES = 8 * 1024 * 1024

export interface BridgeInfo {
  url: string
  token: string
  port: number
}

/**
 * In-process MCP server bound to a single remote session. Streamable HTTP on
 * 127.0.0.1 only, gated by a random per-session bearer token (§7.1). Runs in
 * the main process so its tools call the shared ssh2 client directly.
 *
 * One transport (and its own McpServer) is created per MCP session, keyed by
 * the `mcp-session-id` the SDK issues at `initialize`. A client that drops and
 * reconnects — or a CLI that re-initializes after a config/provider change —
 * gets a fresh session instead of the hard 400 "Server already initialized"
 * that a single shared transport produced. (opencode re-initializes on
 * reconnect; the old design flapped connected→error forever.) The bridge URL,
 * bearer token, tools, and heartbeat are unchanged.
 */
export class McpBridge {
  private http?: Server
  /** One transport per live MCP session (keyed by SDK session id). */
  private transports = new Map<string, StreamableHTTPServerTransport>()
  /** The server bound to each transport, kept so stop() can close it. */
  private servers = new Map<string, McpServer>()
  private state: AgentBridgeState = 'starting'
  private message: string | undefined
  private activeStreams = 0
  private lastActivityAt: number | undefined
  private lastHeartbeatAt: number | undefined
  private heartbeat?: ReturnType<typeof setInterval>
  private heartbeatSeq = 0
  private stopped = false
  /** Live sockets, so stop() can force-close the long-lived SSE stream. */
  private sockets = new Set<Socket>()
  readonly token = randomBytes(24).toString('hex')
  port = 0

  constructor(
    private deps: ToolDeps,
    private onStatus?: (status: AgentBridgeStatus) => void
  ) {}

  getStatus(): AgentBridgeStatus {
    return {
      state: this.state,
      mcpUrl: this.port ? `http://127.0.0.1:${this.port}/mcp` : undefined,
      message: this.message,
      lastActivityAt: this.lastActivityAt,
      lastHeartbeatAt: this.lastHeartbeatAt,
      activeStreams: this.activeStreams
    }
  }

  private emit(state: AgentBridgeState = this.state, message = this.message): void {
    const stateBefore = this.state
    this.state = state
    this.message = message
    this.onStatus?.(this.getStatus())
    // Mirror every state transition into the bridge activity log so the
    // renderer's activity panel sees the same view the status pill shows.
    if (stateBefore !== state) {
      recordBridgeActivity({
        sessionId: this.deps.sessionId,
        kind: 'bridge_state',
        detail: state,
        ok: state !== 'error'
      })
    }
  }

  /** Build a fresh MCP server with the DevTerm tool set (one per session). */
  private createServer(): McpServer {
    const mcp = new McpServer(
      { name: 'devterm', version: '0.1.0' },
      { capabilities: { logging: {} } }
    )
    this.wrapRegisterTool(mcp)
    registerTools(mcp, this.deps)
    return mcp
  }

  async start(): Promise<BridgeInfo> {
    this.emit('starting', 'Starting MCP bridge')

    this.http = createServer((req, res) => void this.handle(req, res))

    // This is a localhost-only bridge with exactly ONE trusted client: the
    // interactive agent CLI we spawn. Node's http.Server ships protective
    // idle timeouts meant for public servers (slowloris / idle-socket
    // exhaustion); here they only cause harm. The CLI holds a long-lived
    // standalone GET SSE stream open for server→client messages, and the MCP
    // SDK puts NO heartbeat on it — so while the operator leaves the agent
    // idle, that quiet stream is fair game for any of these timers. When one
    // fires it silently tears the stream down and the agent surfaces it to the
    // user as "connection dropped". `requestTimeout` (5 min) is the usual
    // culprit — it matches the "drops after a while of idling" report. Disable
    // every teardown timer and keep the connection warm at the TCP layer
    // instead, so the bridge survives any amount of idling.
    this.http.keepAliveTimeout = 0 // don't reap idle keep-alive sockets (default 5s)
    this.http.headersTimeout = 0 // no cap on header receipt (default 60s)
    this.http.requestTimeout = 0 // no cap on request lifetime (default 5min)
    this.http.timeout = 0 // no socket inactivity timeout
    this.http.on('connection', (socket) => {
      // TCP keepalive probes stop the OS/NAT from reaping the idle connection
      // and let us detect a genuinely dead peer; never time out on inactivity.
      socket.setKeepAlive(true, 15000)
      socket.setTimeout(0)
      this.sockets.add(socket)
      socket.once('close', () => this.sockets.delete(socket))
    })

    await new Promise<void>((resolve) => this.http!.listen(0, '127.0.0.1', resolve))
    this.port = (this.http.address() as AddressInfo).port
    const info = { url: `http://127.0.0.1:${this.port}/mcp`, token: this.token, port: this.port }
    this.startHeartbeat()
    this.emit('listening', 'Waiting for agent MCP client')
    return info
  }

  /**
   * Patch `mcp.registerTool` so every tool callback is wrapped in a bridge
   * activity entry. We can't replace the McpServer's CallToolRequestSchema
   * handler cleanly (the SDK does its own validation + error wrapping there),
   * so we hook the registration point: the wrapped callback is what the SDK
   * stores as `tool.handler` and ultimately calls.
   *
   * The detail field is sanitized: newlines escaped and capped at 200 chars so
   * a noisy command (e.g. a multi-line shell script) never floods the log.
   */
  private wrapRegisterTool(mcp: McpServer): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const orig = mcp.registerTool.bind(mcp) as any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(mcp as any).registerTool = (name: string, config: any, cb: any) => {
      const wrapped = async (args: unknown, extra: unknown) => {
        const t0 = Date.now()
        try {
          const result = await cb(args, extra)
          // Tools report expected failures as `isError` results instead of
          // throwing (guardrail denials, timeouts, failed commands). Treat
          // those as errors in the activity log so the Errors filter and the
          // tab status actually reflect them.
          const failed =
            !!result &&
            typeof result === 'object' &&
            (result as { isError?: boolean }).isError === true
          recordBridgeActivity({
            sessionId: this.deps.sessionId,
            kind: 'tool_call',
            tool: name,
            detail: sanitizeDetail(flattenArgs(args)),
            durationMs: Date.now() - t0,
            ok: !failed
          })
          return result
        } catch (err) {
          recordBridgeActivity({
            sessionId: this.deps.sessionId,
            kind: 'tool_call',
            tool: name,
            detail: sanitizeDetail(flattenArgs(args)),
            durationMs: Date.now() - t0,
            ok: false
          })
          throw err
        }
      }
      return orig(name, config, wrapped)
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeat) return
    this.heartbeat = setInterval(() => {
      void this.sendHeartbeat()
    }, BRIDGE_HEARTBEAT_MS)
  }

  private async sendHeartbeat(): Promise<void> {
    if (this.stopped || this.transports.size === 0 || this.activeStreams < 1) return
    const frame = {
      jsonrpc: '2.0' as const,
      method: 'notifications/message',
      params: {
        level: 'debug' as const,
        logger: 'devterm.bridge',
        data: {
          type: 'heartbeat',
          seq: ++this.heartbeatSeq,
          at: Date.now()
        }
      }
    }
    let delivered = false
    for (const transport of this.transports.values()) {
      try {
        await transport.send(frame)
        delivered = true
      } catch {
        /* a single dead session must not stop the others */
      }
    }
    if (delivered) {
      this.lastActivityAt = Date.now()
      this.lastHeartbeatAt = this.lastActivityAt
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!req.url || !req.url.startsWith('/mcp')) {
      res.writeHead(404).end()
      return
    }
    // Anti-DNS-rebinding / anti-cross-origin guard. The only legitimate client
    // is the local agent CLI we spawn: it connects to 127.0.0.1:<port> and never
    // sends an `Origin` header. A web page (e.g. the in-app browser pane, or any
    // browser on the box after a DNS rebind) that tried to reach the bridge would
    // carry an `Origin` and/or a non-loopback `Host`. The bundled MCP SDK ships
    // no rebinding protection, so reject both here before touching the transport.
    if (req.headers['origin']) {
      res.writeHead(403, { 'content-type': 'text/plain' }).end('forbidden')
      return
    }
    const host = req.headers['host']
    if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) {
      res.writeHead(403, { 'content-type': 'text/plain' }).end('forbidden')
      return
    }
    if (!safeBearerEqual(req.headers['authorization'], `Bearer ${this.token}`)) {
      res.writeHead(401, { 'content-type': 'text/plain' }).end('unauthorized')
      return
    }
    this.lastActivityAt = Date.now()
    const sessionId = firstHeader(req.headers['mcp-session-id'])

    // Standalone SSE stream: the client must already own a session.
    if (req.method === 'GET') {
      const transport = sessionId ? this.transports.get(sessionId) : undefined
      if (!transport) {
        res.writeHead(400, { 'content-type': 'text/plain' }).end('missing or invalid session')
        return
      }
      this.activeStreams += 1
      this.emit('connected', 'Agent MCP stream connected')
      res.once('close', () => {
        this.activeStreams = Math.max(0, this.activeStreams - 1)
        if (!this.stopped && this.state !== 'error') {
          this.emit(
            this.activeStreams > 0 ? 'connected' : 'disconnected',
            this.activeStreams > 0 ? 'Agent MCP stream connected' : 'Agent MCP stream closed'
          )
        }
      })
      try {
        await transport.handleRequest(req, res)
      } catch (err) {
        this.emit('error', err instanceof Error ? err.message : String(err))
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' }).end('bridge error')
        console.error('[mcp] handleRequest error:', err)
      }
      return
    }

    if (req.method === 'DELETE') {
      const transport = sessionId ? this.transports.get(sessionId) : undefined
      if (!transport) {
        res.writeHead(400, { 'content-type': 'text/plain' }).end('missing or invalid session')
        return
      }
      try {
        await transport.handleRequest(req, res)
      } catch (err) {
        this.emit('error', err instanceof Error ? err.message : String(err))
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' }).end('bridge error')
      }
      return
    }

    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': 'text/plain' }).end('method not allowed')
      return
    }

    // Read the JSON-RPC body up front so we can tell an `initialize` (which
    // starts a new session) from a normal request that must carry its session
    // id. The transport accepts the pre-parsed body, so it is not read twice.
    const body = await readJsonBody(req)
    if (body === undefined) {
      res.writeHead(400, { 'content-type': 'text/plain' }).end('invalid json body')
      return
    }

    let transport = sessionId ? this.transports.get(sessionId) : undefined
    if (!transport) {
      if (sessionId || !isInitializeRequest(body)) {
        // Unknown session (the bridge was restarted) or a non-initialize
        // request with no session id. A well-behaved client re-initializes.
        res.writeHead(400, { 'content-type': 'text/plain' }).end('missing or invalid session')
        return
      }
      // New session: its own transport + server so a reconnecting client can
      // initialize again instead of hitting "Server already initialized".
      const mcp = this.createServer()
      const created = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (sid) => {
          this.transports.set(sid, created)
          this.servers.set(sid, mcp)
        }
      })
      created.onerror = (error) => {
        this.emit('error', error.message)
        console.error('[mcp] transport error:', error)
      }
      created.onclose = () => {
        const sid = created.sessionId
        if (sid) {
          this.transports.delete(sid)
          this.servers.delete(sid)
        }
        // Do NOT call mcp.close() here: the transport invokes onclose from
        // inside its own close(), and mcp.close() closes the transport again —
        // which would recurse. The orphaned server is garbage collected.
        if (this.stopped) return
        if (this.transports.size === 0) this.emit('disconnected', 'MCP transport closed')
      }
      try {
        await mcp.connect(created)
      } catch (err) {
        // Never leave a half-wired transport behind if the handshake setup fails.
        try {
          await created.close()
        } catch {
          /* already closed */
        }
        try {
          await mcp.close()
        } catch {
          /* already closed */
        }
        this.emit('error', err instanceof Error ? err.message : String(err))
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' }).end('bridge error')
        return
      }
      transport = created
    }

    if (
      this.state === 'starting' ||
      this.state === 'listening' ||
      this.state === 'disconnected' ||
      // A transient transport/handle error must not pin the bridge red
      // forever: a subsequent valid agent request proves liveness again.
      this.state === 'error'
    ) {
      this.emit('connected', 'Agent MCP request received')
    }

    try {
      await transport.handleRequest(req, res, body)
    } catch (err) {
      this.emit('error', err instanceof Error ? err.message : String(err))
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' }).end('bridge error')
      console.error('[mcp] handleRequest error:', err)
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.heartbeat) {
      clearInterval(this.heartbeat)
      this.heartbeat = undefined
    }
    this.emit('stopped', 'MCP bridge stopped')
    for (const [sid, transport] of [...this.transports]) {
      // Capture the server before closing the transport: onclose deletes it
      // from the map, so a lookup afterwards would miss it.
      const server = this.servers.get(sid)
      try {
        await transport.close()
      } catch {
        /* already gone */
      }
      try {
        await server?.close()
      } catch {
        /* already gone */
      }
    }
    this.transports.clear()
    this.servers.clear()
    // http.close() only resolves once every open connection drains — and the
    // agent's long-lived SSE GET stream never does on its own. Destroy the
    // tracked sockets first, then await the close with a bounded timeout so
    // stop() can't hang the caller (closeOne awaits it).
    if (this.http) {
      const http = this.http
      for (const socket of this.sockets) socket.destroy()
      this.sockets.clear()
      await Promise.race([
        new Promise<void>((resolve) => http.close(() => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 2000))
      ])
    }
  }
}

/** First value of a possibly-arrayed request header. */
function firstHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0]
  return value
}

/**
 * Read and JSON-parse a request body with a hard size cap. Returns `undefined`
 * for a malformed/oversized body so the caller can answer 400 without throwing.
 */
function readJsonBody(req: IncomingMessage): Promise<unknown | undefined> {
  return new Promise((resolve) => {
    let data = ''
    let settled = false
    const done = (value: unknown | undefined) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    req.on('data', (chunk: Buffer) => {
      data += chunk.toString('utf8')
      if (data.length > MAX_REQUEST_BYTES) {
        req.destroy()
        done(undefined)
      }
    })
    req.on('end', () => {
      try {
        done(data.length > 0 ? JSON.parse(data) : undefined)
      } catch {
        done(undefined)
      }
    })
    req.on('error', () => done(undefined))
  })
}

/**
 * Constant-time compare of the `Authorization` header against the expected
 * `Bearer <token>` value. Avoids the early-exit timing side-channel of `!==`.
 * Returns false on a missing header or length mismatch (length itself is not
 * secret — the token is fixed-width).
 */
function safeBearerEqual(actual: string | undefined, expected: string): boolean {
  if (typeof actual !== 'string') return false
  const a = Buffer.from(actual)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * Sanitize a detail string before it goes into the bridge activity log.
 * Newlines are escaped (the panel is one line per row), and the string is
 * capped at 200 chars so a noisy command (e.g. a multi-line shell script)
 * never floods the log or the renderer's row layout.
 */
export function sanitizeDetail(s: string): string {
  const flat = s
    .replace(/[\r\n]+/g, ' ⏎ ')
    .replace(/\s+/g, ' ')
    .trim()
  if (flat.length <= 200) return flat
  return flat.slice(0, 197) + '…'
}

/**
 * Best-effort flatten of tool args for the detail line. We only need a short
 * human-readable hint of what was asked; full args are available in the
 * renderer's expanded view via the original entry if needed.
 */
function flattenArgs(args: unknown): string {
  if (args == null) return ''
  if (typeof args === 'string') return args
  if (typeof args !== 'object') return String(args)
  const parts: string[] = []
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    if (v == null) continue
    if (typeof v === 'string') parts.push(`${k}=${v}`)
    else if (typeof v === 'number' || typeof v === 'boolean') parts.push(`${k}=${String(v)}`)
    else parts.push(`${k}=${JSON.stringify(v).slice(0, 60)}`)
  }
  return parts.join(' ')
}
