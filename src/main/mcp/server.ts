import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import { randomBytes, randomUUID } from 'crypto'
import type { AddressInfo } from 'net'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
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
  readonly token = randomBytes(24).toString('hex')
  port = 0

  constructor(private deps: ToolDeps) {}

  async start(): Promise<BridgeInfo> {
    this.mcp = new McpServer({ name: 'devterm', version: '0.1.0' })
    registerTools(this.mcp, this.deps)

    // One long-lived client (claude) per bridge: a single stateful transport
    // keeps the session across initialize → listTools → callTool. JSON responses.
    this.transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true
    })
    await this.mcp.connect(this.transport)

    this.http = createServer((req, res) => void this.handle(req, res))
    await new Promise<void>((resolve) => this.http!.listen(0, '127.0.0.1', resolve))
    this.port = (this.http.address() as AddressInfo).port
    return { url: `http://127.0.0.1:${this.port}/mcp`, token: this.token, port: this.port }
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
    // Let the transport consume the request body stream itself (don't pre-read).
    try {
      await this.transport!.handleRequest(req, res)
    } catch (err) {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' }).end('bridge error')
      console.error('[mcp] handleRequest error:', err)
    }
  }

  async stop(): Promise<void> {
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
