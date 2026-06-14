import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import { randomBytes, randomUUID } from 'crypto'
import type { AddressInfo } from 'net'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { AgentBridgeState, AgentBridgeStatus } from '@shared/types'
import { registerTools, type ToolDeps } from './tools'
import { recordBridgeActivity } from '../foundation-ipc'

const BRIDGE_HEARTBEAT_MS = 25000

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
  private state: AgentBridgeState = 'starting'
  private message: string | undefined
  private activeStreams = 0
  private lastActivityAt: number | undefined
  private lastHeartbeatAt: number | undefined
  private heartbeat?: ReturnType<typeof setInterval>
  private heartbeatSeq = 0
  private stopped = false
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

  async start(): Promise<BridgeInfo> {
    this.emit('starting', 'Starting MCP bridge')
    this.mcp = new McpServer(
      { name: 'devterm', version: '0.1.0' },
      { capabilities: { logging: {} } }
    )
    this.wrapRegisterTool(this.mcp)
    registerTools(this.mcp, this.deps)

    // One long-lived client (the agent) per bridge: a single stateful transport
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
    // interactive `pi` CLI we spawn. Node's http.Server ships protective
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
          recordBridgeActivity({
            sessionId: this.deps.sessionId,
            kind: 'tool_call',
            tool: name,
            detail: sanitizeDetail(flattenArgs(args)),
            durationMs: Date.now() - t0,
            ok: true
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
    if (this.stopped || !this.transport || this.activeStreams < 1) return
    try {
      await this.transport.send({
        jsonrpc: '2.0',
        method: 'notifications/message',
        params: {
          level: 'debug',
          logger: 'devterm.bridge',
          data: {
            type: 'heartbeat',
            seq: ++this.heartbeatSeq,
            at: Date.now()
          }
        }
      })
      this.lastActivityAt = Date.now()
      this.lastHeartbeatAt = this.lastActivityAt
    } catch (err) {
      if (!this.stopped) {
        const message = err instanceof Error ? err.message : String(err)
        this.emit('disconnected', `Bridge heartbeat failed: ${message}`)
        console.error('[mcp] heartbeat failed:', err)
      }
    }
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
    if (this.heartbeat) {
      clearInterval(this.heartbeat)
      this.heartbeat = undefined
    }
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

/**
 * Sanitize a detail string before it goes into the bridge activity log.
 * Newlines are escaped (the panel is one line per row), and the string is
 * capped at 200 chars so a noisy command (e.g. a multi-line shell script)
 * never floods the log or the renderer's row layout.
 */
export function sanitizeDetail(s: string): string {
  const flat = s.replace(/[\r\n]+/g, ' ⏎ ').replace(/\s+/g, ' ').trim()
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
