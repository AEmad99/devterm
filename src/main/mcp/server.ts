import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import { randomBytes, randomUUID } from 'crypto'
import type { AddressInfo } from 'net'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { ClaudeBridgeState, ClaudeBridgeStatus } from '@shared/types'
import { registerTools, type ToolDeps } from './tools'

export interface BridgeInfo {
  url: string
  token: string
  port: number
}

/**
 * In-process MCP server bound to a single remote session. Streamable HTTP on
 * 127.0.0.1 only, gated by a random per-session bearer token (§7.1). Runs in
 * the main process so its tools call the shared ssh2 client directly.
 */
export class McpBridge {
  private http?: Server
  private transport?: StreamableHTTPServerTransport
  private mcp?: McpServer
  private state: ClaudeBridgeState = 'starting'
  private message: string | undefined
  private activeStreams = 0
  private lastActivityAt: number | undefined
  private stopped = false
  readonly token = randomBytes(24).toString('hex')
  port = 0

  constructor(
    private deps: ToolDeps,
    private onStatus?: (status: ClaudeBridgeStatus) => void
  ) {}

  getStatus(): ClaudeBridgeStatus {
    return {
      state: this.state,
      mcpUrl: this.port ? `http://127.0.0.1:${this.port}/mcp` : undefined,
      message: this.message,
      lastActivityAt: this.lastActivityAt,
      activeStreams: this.activeStreams
    }
  }

  private emit(state: ClaudeBridgeState = this.state, message = this.message): void {
    this.state = state
    this.message = message
    this.onStatus?.(this.getStatus())
  }

  async start(): Promise<BridgeInfo> {
    this.emit('starting', 'Starting MCP bridge')
    this.mcp = new McpServer({ name: 'devterm', version: '0.1.0' })
    registerTools(this.mcp, this.deps)

    // One long-lived client (claude) per bridge: a single stateful transport
    // keeps the session across initialize → listTools → callTool. JSON responses.
    this.transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true
    })
    this.transport.onerror = (error) => {
      this.emit('error', error.message)
      console.error('[mcp] transport error:', error)
    }
    this.transport.onclose = () => this.emit('stopped', 'MCP transport closed')
    await this.mcp.connect(this.transport)

    this.http = createServer((req, res) => void this.handle(req, res))

    // This is a localhost-only bridge with exactly ONE trusted client: the
    // interactive `claude` CLI we spawn. Node's http.Server ships protective
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
    })

    await new Promise<void>((resolve) => this.http!.listen(0, '127.0.0.1', resolve))
    this.port = (this.http.address() as AddressInfo).port
    const info = { url: `http://127.0.0.1:${this.port}/mcp`, token: this.token, port: this.port }
    this.emit('listening', 'Waiting for agent MCP client')
    return info
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!req.url || !req.url.startsWith('/mcp')) {
      res.writeHead(404).end()
      return
    }
    if (req.headers['authorization'] !== `Bearer ${this.token}`) {
      res.writeHead(401, { 'content-type': 'text/plain' }).end('unauthorized')
      return
    }
    this.lastActivityAt = Date.now()
    const isStandaloneStream = req.method === 'GET'
    let trackedStream = false
    if (isStandaloneStream) {
      trackedStream = true
      this.activeStreams += 1
      this.emit('connected', 'Agent MCP stream connected')
      res.once('close', () => {
        if (!trackedStream) return
        trackedStream = false
        this.activeStreams = Math.max(0, this.activeStreams - 1)
        if (!this.stopped && this.state !== 'error') {
          this.emit(
            this.activeStreams > 0 ? 'connected' : 'disconnected',
            this.activeStreams > 0 ? 'Agent MCP stream connected' : 'Agent MCP stream closed'
          )
        }
      })
    } else if (
      this.state === 'starting' ||
      this.state === 'listening' ||
      this.state === 'disconnected'
    ) {
      this.emit('connected', 'Agent MCP request received')
    }
    // Let the transport consume the request body stream itself (don't pre-read).
    try {
      await this.transport!.handleRequest(req, res)
    } catch (err) {
      this.emit('error', err instanceof Error ? err.message : String(err))
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' }).end('bridge error')
      console.error('[mcp] handleRequest error:', err)
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.emit('stopped', 'MCP bridge stopped')
    try {
      await this.transport?.close()
    } catch {
      /* ignore */
    }
    try {
      await this.mcp?.close()
    } catch {
      /* ignore */
    }
    this.http?.close()
  }
}
