import { createServer, type Server } from 'http'
import { createReadStream, existsSync, statSync } from 'fs'
import { extname, join, normalize, relative, resolve, sep } from 'path'
import { randomUUID } from 'crypto'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf'
}

export function resolveSafePath(root: string, urlPath: string): string | null {
  const decoded = decodeURIComponent((urlPath.split('?')[0] || '/').replace(/^\/+/, ''))
  const abs = resolve(root, decoded)
  const rel = relative(resolve(root), abs)
  if (rel.startsWith('..') || rel.startsWith(`..${sep}`) || normalize(rel) === '..') return null
  if (abs !== resolve(root) && !abs.startsWith(resolve(root) + sep) && !abs.startsWith(resolve(root) + '/')) {
    return null
  }
  return abs
}

export interface FolderServe {
  id: string
  url: string
  port: number
  folderPath: string
  close: () => Promise<void>
}

export function startFolderServer(folderPath: string): Promise<FolderServe> {
  const root = resolve(folderPath)
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    return Promise.reject(new Error(`Folder is not a directory: ${folderPath}`))
  }
  const id = randomUUID()
  return new Promise((resolveServe, reject) => {
    const server: Server = createServer((req, res) => {
      const urlPath = req.url || '/'
      let abs = resolveSafePath(root, urlPath)
      if (!abs) {
        res.writeHead(403)
        res.end('forbidden')
        return
      }
      try {
        if (existsSync(abs) && statSync(abs).isDirectory()) {
          abs = join(abs, 'index.html')
        }
        if (!existsSync(abs) || !statSync(abs).isFile()) {
          res.writeHead(404)
          res.end('not found')
          return
        }
        const mime = MIME[extname(abs).toLowerCase()] || 'application/octet-stream'
        res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' })
        createReadStream(abs).pipe(res)
      } catch (err) {
        res.writeHead(500)
        res.end(err instanceof Error ? err.message : 'error')
      }
    })
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (!addr || typeof addr === 'string') {
        server.close()
        reject(new Error('Failed to bind preview server'))
        return
      }
      resolveServe({
        id,
        url: `http://127.0.0.1:${addr.port}/`,
        port: addr.port,
        folderPath: root,
        close: () =>
          new Promise((r) => {
            server.close(() => r())
          })
      })
    })
  })
}
